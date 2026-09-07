import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Sink } from '../dist/index.mjs';

function makeToolCallEvent(overrides = {}) {
  return {
    event_type: 'tool_call',
    ts: new Date('2026-09-01T23:25:24.000Z'),
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
    ...overrides
  };
}

function makeSessionSummaryEvent(overrides = {}) {
  return {
    event_type: 'session_summary',
    ts: new Date('2026-09-01T23:25:24.000Z'),
    session_id: 'sess-1',
    server_name: 's',
    server_version: null,
    user_id: null,
    org_id: null,
    call_count: 1,
    distinct_tools_used: 1,
    wall_duration_ms: 5,
    error_count: 0,
    ...overrides
  };
}

// A minimal fake matching the D1Database Worker Bindings API surface the
// sink relies on: prepare().bind() returns a statement, batch() takes the
// whole array in one call (this is the assertion that matters - the sink
// must not call db.batch() once per row, since batch() is what buys the
// transactional all-or-nothing behavior D1 promises).
function makeFakeDb() {
  const batchCalls = [];
  return {
    batchCalls,
    prepare(query) {
      return {
        query,
        values: undefined,
        bind(...values) {
          return { query, values };
        }
      };
    },
    async batch(statements) {
      batchCalls.push(statements);
      return statements.map(() => ({ success: true }));
    }
  };
}

test('writes tool_call rows in a single batch() call, ts as epoch ms, success as 0/1', async () => {
  const db = makeFakeDb();
  const sink = d1Sink(db);

  await sink.write([
    makeToolCallEvent({ success: true }),
    makeToolCallEvent({ tool_name: 'other-tool', success: false })
  ]);

  assert.equal(db.batchCalls.length, 1, 'both rows must go through one batch() call');
  const statements = db.batchCalls[0];
  assert.equal(statements.length, 2);
  assert.match(statements[0].query, /insert into mcpsignals_tool_call/);

  const [tsValue, , , , , , , , , , , successValue] = statements[0].values;
  assert.equal(tsValue, new Date('2026-09-01T23:25:24.000Z').getTime());
  assert.equal(typeof tsValue, 'number');
  assert.equal(successValue, 1);

  const failedRowValues = statements[1].values;
  assert.equal(failedRowValues[11], 0);
});

test('writes session_summary rows into the session summary table', async () => {
  const db = makeFakeDb();
  const sink = d1Sink(db);

  await sink.write([makeSessionSummaryEvent()]);

  assert.equal(db.batchCalls.length, 1);
  assert.match(db.batchCalls[0][0].query, /insert into mcpsignals_session_summary/);
});

test('mixed batches of both event types still go through one batch() call', async () => {
  const db = makeFakeDb();
  const sink = d1Sink(db);

  await sink.write([makeToolCallEvent(), makeSessionSummaryEvent()]);

  assert.equal(db.batchCalls.length, 1);
  assert.equal(db.batchCalls[0].length, 2);
});

test('an empty batch never calls db.batch()', async () => {
  const db = makeFakeDb();
  const sink = d1Sink(db);

  await sink.write([]);

  assert.equal(db.batchCalls.length, 0);
});

test('respects custom table names', async () => {
  const db = makeFakeDb();
  const sink = d1Sink(db, {
    toolCallTable: 'custom_tool_call',
    sessionSummaryTable: 'custom_summary'
  });

  await sink.write([makeToolCallEvent(), makeSessionSummaryEvent()]);

  const [toolCallStmt, summaryStmt] = db.batchCalls[0];
  assert.match(toolCallStmt.query, /insert into custom_tool_call/);
  assert.match(summaryStmt.query, /insert into custom_summary/);
});

test('an oversized `arguments` payload is dropped (written as null) instead of risking the whole batch', async () => {
  const db = makeFakeDb();
  const sink = d1Sink(db);
  const originalConsoleError = console.error;
  let warnCount = 0;
  console.error = () => void warnCount++;

  try {
    // Comfortably over the 1,000,000-byte cap once JSON-stringified.
    const hugeArguments = { blob: 'x'.repeat(2_000_000) };

    await sink.write([
      makeToolCallEvent({ arguments: hugeArguments }),
      makeToolCallEvent({ tool_name: 'second', arguments: hugeArguments })
    ]);

    assert.equal(
      db.batchCalls.length,
      1,
      'the batch must still be sent, just without the oversized field'
    );
    const statements = db.batchCalls[0];
    const argumentsIndex = 16;
    assert.equal(statements[0].values[argumentsIndex], null);
    assert.equal(statements[1].values[argumentsIndex], null);
    assert.equal(warnCount, 1, 'the warning is logged at most once per sink instance');
  } finally {
    console.error = originalConsoleError;
  }
});

test('arguments under the cap are passed through as a JSON string', async () => {
  const db = makeFakeDb();
  const sink = d1Sink(db);

  await sink.write([makeToolCallEvent({ arguments: { a: 1 } })]);

  const argumentsIndex = 16;
  assert.equal(db.batchCalls[0][0].values[argumentsIndex], JSON.stringify({ a: 1 }));
});
