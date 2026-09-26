import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { consoleSink, type ToolCallEvent } from 'mcpsignals';

function makeEvent(i: number): ToolCallEvent {
  return {
    event_type: 'tool_call',
    ts: new Date('2026-09-16T12:00:00.000Z'),
    server_name: 's',
    server_version: null,
    tool_name: `tool-${i}`,
    session_id: null,
    agent_id: null,
    client_name: null,
    client_version: null,
    user_id: null,
    org_id: null,
    duration_ms: 1,
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
    destructive_hint: null
  };
}

/** Collects everything written to a stream into an array of strings. */
function collectingStream() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    }
  });
  return { stream, chunks };
}

/**
 * Runs `fn` with `process.stdout.write` swapped for a recorder, and restores
 * the original write in `finally` so a failing assertion cannot leave the
 * test reporter's own stdout broken.
 */
async function withCapturedStdout(fn: () => Promise<void>) {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks;
}

test('writes to process.stdout by default', async () => {
  const chunks = await withCapturedStdout(async () => {
    await consoleSink().write([makeEvent(1)]);
  });

  assert.equal(chunks.length, 1);
  assert.equal(JSON.parse(chunks[0]).tool_name, 'tool-1');
});

test('writes to the configured stream and not to stdout', async () => {
  const { stream, chunks } = collectingStream();

  const stdoutChunks = await withCapturedStdout(async () => {
    await consoleSink({ stream }).write([makeEvent(1)]);
  });

  assert.equal(stdoutChunks.length, 0, 'stdout should receive nothing');
  assert.equal(chunks.length, 1);
  assert.equal(JSON.parse(chunks[0]).tool_name, 'tool-1');
});

test('emits one newline-terminated JSON line per event', async () => {
  const { stream, chunks } = collectingStream();

  await consoleSink({ stream }).write([makeEvent(1), makeEvent(2), makeEvent(3)]);

  assert.equal(chunks.length, 3);
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(chunk.endsWith('\n'), 'each event ends with a newline');
    assert.equal(chunk.slice(0, -1).includes('\n'), false, 'no embedded newlines');
    const parsed = JSON.parse(chunk);
    assert.equal(parsed.event_type, 'tool_call');
    assert.equal(parsed.tool_name, `tool-${i + 1}`);
    assert.equal(parsed.ts, '2026-09-16T12:00:00.000Z');
  }
});
