import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postgresSink } from '../dist/index.mjs';

const TOOL_CALL_COLUMNS = 19;
const SESSION_SUMMARY_COLUMNS = 10;

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

// A minimal fake matching the `pg` Pool surface the sink relies on:
// query(text, values). The assertion that matters is the call count - the
// sink must issue one multi-row insert per table per flush, not one
// round trip per event.
function makeFakePool() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rowCount: 0 };
    }
  };
}

function placeholders(text) {
  return [...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
}

test('N tool_call events produce exactly one query with 19*N placeholders and a flat values array', async () => {
  const pool = makeFakePool();
  const sink = postgresSink({ pool });

  await sink.write([
    makeToolCallEvent({ tool_name: 'first', success: true }),
    makeToolCallEvent({ tool_name: 'second', success: false }),
    makeToolCallEvent({ tool_name: 'third', duration_ms: 42 })
  ]);

  assert.equal(pool.calls.length, 1, 'three rows must go through one query() call');
  const { text, values } = pool.calls[0];
  assert.match(text, /insert into mcpsignals_tool_call/);

  const found = placeholders(text);
  assert.equal(found.length, TOOL_CALL_COLUMNS * 3);
  assert.deepEqual(
    found,
    Array.from({ length: TOOL_CALL_COLUMNS * 3 }, (_, i) => i + 1),
    'placeholders must be $1..$57 in order'
  );
  assert.match(text, /\(\$1,.*\$19\),\s*\(\$20,.*\$38\),\s*\(\$39,.*\$57\)/s);

  assert.equal(values.length, TOOL_CALL_COLUMNS * 3);
  // Column order is (ts, server_name, server_version, tool_name, ..., duration_ms at 10, success at 11).
  assert.equal(values[3], 'first');
  assert.equal(values[TOOL_CALL_COLUMNS + 3], 'second');
  assert.equal(values[TOOL_CALL_COLUMNS * 2 + 3], 'third');
  assert.equal(values[11], true);
  assert.equal(values[TOOL_CALL_COLUMNS + 11], false);
  assert.equal(values[TOOL_CALL_COLUMNS * 2 + 10], 42);
});

test('a mixed batch produces exactly two queries, one per table', async () => {
  const pool = makeFakePool();
  const sink = postgresSink({ pool });

  await sink.write([
    makeToolCallEvent(),
    makeSessionSummaryEvent({ session_id: 'a' }),
    makeToolCallEvent({ tool_name: 'other' }),
    makeSessionSummaryEvent({ session_id: 'b' })
  ]);

  assert.equal(pool.calls.length, 2);
  const toolCall = pool.calls.find(c => /insert into mcpsignals_tool_call/.test(c.text));
  const summary = pool.calls.find(c => /insert into mcpsignals_session_summary/.test(c.text));
  assert.ok(toolCall, 'one query must target the tool_call table');
  assert.ok(summary, 'one query must target the session_summary table');

  assert.equal(placeholders(toolCall.text).length, TOOL_CALL_COLUMNS * 2);
  assert.equal(toolCall.values.length, TOOL_CALL_COLUMNS * 2);

  assert.equal(placeholders(summary.text).length, SESSION_SUMMARY_COLUMNS * 2);
  assert.equal(summary.values.length, SESSION_SUMMARY_COLUMNS * 2);
  assert.equal(summary.values[1], 'a');
  assert.equal(summary.values[SESSION_SUMMARY_COLUMNS + 1], 'b');
});

test('a batch of only session_summary events produces one query', async () => {
  const pool = makeFakePool();
  const sink = postgresSink({ pool });

  await sink.write([makeSessionSummaryEvent()]);

  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].text, /insert into mcpsignals_session_summary/);
  assert.equal(pool.calls[0].values.length, SESSION_SUMMARY_COLUMNS);
});

test('an empty batch never calls pool.query()', async () => {
  const pool = makeFakePool();
  const sink = postgresSink({ pool });

  await sink.write([]);

  assert.equal(pool.calls.length, 0);
});

test('ts stays a Date and arguments stays an object in values (pg encodes them per bound value)', async () => {
  const pool = makeFakePool();
  const sink = postgresSink({ pool });
  const ts = new Date('2026-09-01T23:25:24.000Z');
  const args = { a: 1, nested: { b: 'c' } };

  await sink.write([
    makeToolCallEvent({ ts, arguments: args }),
    makeToolCallEvent({ ts, arguments: args })
  ]);

  const { values } = pool.calls[0];
  assert.ok(values[0] instanceof Date);
  assert.equal(values[0], ts);
  assert.ok(values[TOOL_CALL_COLUMNS] instanceof Date);
  assert.equal(typeof values[16], 'object');
  assert.deepEqual(values[16], args);
  assert.deepEqual(values[TOOL_CALL_COLUMNS + 16], args);
});

test('respects custom table names', async () => {
  const pool = makeFakePool();
  const sink = postgresSink({
    pool,
    toolCallTable: 'custom_tool_call',
    sessionSummaryTable: 'custom_summary'
  });

  await sink.write([makeToolCallEvent(), makeSessionSummaryEvent()]);

  assert.ok(pool.calls.some(c => /insert into custom_tool_call/.test(c.text)));
  assert.ok(pool.calls.some(c => /insert into custom_summary/.test(c.text)));
});
