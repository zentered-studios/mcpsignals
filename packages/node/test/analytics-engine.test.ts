import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsEngineSink, type ToolCallEvent } from 'mcpsignals';

function makeToolCallEvent(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    event_type: 'tool_call',
    ts: new Date('2026-09-01T23:25:24.123Z'),
    server_name: 's',
    server_version: null,
    tool_name: 'my-tool',
    session_id: null,
    agent_id: null,
    client_name: null,
    client_version: null,
    user_id: null,
    org_id: null,
    duration_ms: 5,
    success: true,
    error_kind: null,
    error_message: null,
    request_bytes: 1,
    response_bytes: 1,
    arguments: null,
    intent: null,
    transport: null,
    protocol_version: null,
    request_id: null,
    trace_id: null,
    parent_span_id: null,
    result_type: null,
    error_code: null,
    read_only_hint: null,
    destructive_hint: null,
    ...overrides
  };
}

interface DataPoint {
  indexes?: (string | null)[];
  doubles?: number[];
  blobs?: (string | null)[];
}

// A fake AnalyticsEngineDataset: writeDataPoint() is synchronous and takes
// one data point, which is the whole Workers binding surface.
function makeFakeDataset() {
  const points: DataPoint[] = [];
  return {
    points,
    writeDataPoint(point: DataPoint) {
      points.push(point);
    }
  };
}

function silenceWarnings() {
  const original = console.error;
  const warnings: string[] = [];
  console.error = (message: string) => void warnings.push(message);
  return { warnings, restore: () => (console.error = original) };
}

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;

test('writes one data point per tool_call with blobs, doubles and the index in schema order', async () => {
  const dataset = makeFakeDataset();
  const sink = analyticsEngineSink(dataset);
  const ts = new Date('2026-09-01T23:25:24.123Z');

  await sink.write([
    makeToolCallEvent({
      ts,
      server_name: 'srv',
      server_version: '1.2.3',
      tool_name: 'search',
      session_id: 'sess',
      agent_id: 'agent',
      client_name: 'cli',
      client_version: '9.9',
      user_id: 'u1',
      org_id: 'o1',
      duration_ms: 42,
      success: false,
      error_kind: 'validation',
      error_message: 'bad input',
      request_bytes: 10,
      response_bytes: 20,
      arguments: { q: 'x' },
      intent: 'find x',
      transport: 'http',
      protocol_version: '2026-07-28',
      request_id: '7',
      trace_id: 'a'.repeat(32),
      parent_span_id: 'b'.repeat(16),
      result_type: 'complete',
      error_code: -32602,
      read_only_hint: true,
      destructive_hint: false
    })
  ]);

  assert.equal(dataset.points.length, 1);
  assert.deepEqual(dataset.points[0], {
    indexes: ['search'],
    blobs: [
      'srv',
      '1.2.3',
      'search',
      'sess',
      'agent',
      'cli',
      '9.9',
      'u1',
      'o1',
      'validation',
      'bad input',
      '{"q":"x"}',
      'find x',
      'http',
      '2026-07-28',
      '7',
      'a'.repeat(32),
      'b'.repeat(16),
      'complete'
    ],
    doubles: [ts.getTime(), 42, 0, 10, 20, -32602, 1, 0]
  });
});

test('writes one data point per event, never batching', async () => {
  const dataset = makeFakeDataset();
  const sink = analyticsEngineSink(dataset);

  await sink.write([makeToolCallEvent(), makeToolCallEvent({ tool_name: 'other' })]);

  assert.equal(dataset.points.length, 2);
  assert.deepEqual(dataset.points[1].indexes, ['other']);
});

test('null strings become "", a null error_code becomes 0, and null hints become -1', async () => {
  const dataset = makeFakeDataset();
  const sink = analyticsEngineSink(dataset);

  await sink.write([makeToolCallEvent()]);

  const [point] = dataset.points;
  assert.equal(point.blobs?.length, 19);
  assert.equal(point.blobs?.[0], 's');
  assert.equal(point.blobs?.[2], 'my-tool');
  for (const [i, blob] of (point.blobs ?? []).entries()) {
    if (i === 0 || i === 2) continue;
    assert.equal(blob, '', `blob${i + 1} should be "" for a null field`);
  }
  assert.deepEqual(point.doubles?.slice(-3), [0, -1, -1]);
  assert.equal(point.doubles?.[2], 1, 'success is 1');
});

test('an empty batch writes nothing', async () => {
  const dataset = makeFakeDataset();
  const sink = analyticsEngineSink(dataset);

  await sink.write([]);

  assert.equal(dataset.points.length, 0);
});

test('the index is cut to 96 UTF-8 bytes without splitting a character; blob3 keeps the full tool_name', async () => {
  const dataset = makeFakeDataset();
  const sink = analyticsEngineSink(dataset);
  // 47 ASCII bytes, then 3-byte characters: 47 + 3*16 = 95 fits, a 17th would make 98.
  const toolName = 'x'.repeat(47) + '€'.repeat(30);

  await sink.write([makeToolCallEvent({ tool_name: toolName })]);

  const [point] = dataset.points;
  const index = point.indexes?.[0] ?? '';
  assert.equal(index, 'x'.repeat(47) + '€'.repeat(16));
  assert.ok(byteLength(index) <= 96);
  assert.equal(point.blobs?.[2], toolName);
});

test('oversized arguments are dropped whole, since truncated JSON cannot be parsed', async () => {
  const dataset = makeFakeDataset();
  const sink = analyticsEngineSink(dataset);
  const { warnings, restore } = silenceWarnings();

  try {
    await sink.write([
      makeToolCallEvent({ arguments: { blob: 'x'.repeat(20_000) }, intent: 'keep me' })
    ]);
  } finally {
    restore();
  }

  const [point] = dataset.points;
  assert.equal(point.blobs?.[11], '');
  assert.equal(point.blobs?.[12], 'keep me');
  assert.equal(warnings.length, 1);
});

test('blobs over 16 KB in total are truncated to fit, and the warning is logged once per sink', async () => {
  const dataset = makeFakeDataset();
  const sink = analyticsEngineSink(dataset);
  const { warnings, restore } = silenceWarnings();
  // 8000 + 6000 + 4000 bytes: the three no longer fit in 16 KB. The emoji
  // is a surrogate pair, so a cut by UTF-16 units could split it.
  const longError = '€'.repeat(2000);
  const longIntent = '😀'.repeat(1000);

  try {
    await sink.write([
      makeToolCallEvent({
        server_name: 'n'.repeat(8000),
        error_message: longError,
        intent: longIntent
      }),
      makeToolCallEvent({
        server_name: 'n'.repeat(8000),
        error_message: longError,
        intent: longIntent
      })
    ]);
  } finally {
    restore();
  }

  for (const point of dataset.points) {
    const blobs = (point.blobs ?? []) as string[];
    const total = blobs.reduce((sum, blob) => sum + byteLength(blob), 0);
    assert.ok(total <= 16_000, `blobs total ${total} bytes`);
    assert.equal(blobs[0], 'n'.repeat(8000), 'identifiers are kept whole');
    assert.equal(blobs[10], longError, 'error_message fits whole');
    assert.ok(blobs[12].length > 0 && blobs[12].length < longIntent.length, 'intent is truncated');
    assert.ok(longIntent.startsWith(blobs[12]), 'intent is a prefix of the original');
    assert.ok(!/[\ud800-\udbff]$/.test(blobs[12]), 'no lone surrogate at the cut');
  }
  assert.equal(warnings.length, 1);
});

test('a flush writes at most 250 data points and warns once about the rest', async () => {
  const dataset = makeFakeDataset();
  const sink = analyticsEngineSink(dataset);
  const { warnings, restore } = silenceWarnings();
  const events = Array.from({ length: 260 }, (_, i) => makeToolCallEvent({ tool_name: `t${i}` }));

  try {
    await sink.write(events);
    await sink.write(events);
  } finally {
    restore();
  }

  assert.equal(dataset.points.length, 500);
  assert.deepEqual(dataset.points[249].indexes, ['t249']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /250/);
});
