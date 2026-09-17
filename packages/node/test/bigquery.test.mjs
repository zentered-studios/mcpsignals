import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bigquerySink } from '../dist/index.mjs';

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

// A minimal fake matching the @google-cloud/bigquery surface the sink relies
// on: client.dataset(name).table(name).insert(rows). Each insert() call is
// recorded with the dataset and table it targeted.
function makeFakeClient() {
  const inserts = [];
  return {
    inserts,
    dataset(datasetName) {
      return {
        table(tableName) {
          return {
            async insert(rows) {
              inserts.push({ dataset: datasetName, table: tableName, rows });
            }
          };
        }
      };
    }
  };
}

test('uses the injected client and the default dataset/table names', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({ client });

  await sink.write([makeToolCallEvent(), makeSessionSummaryEvent()]);

  assert.deepEqual(
    client.inserts.map(({ dataset, table }) => ({ dataset, table })),
    [
      { dataset: 'mcpsignals', table: 'tool_call' },
      { dataset: 'mcpsignals', table: 'session_summary' }
    ]
  );
});

test('respects custom dataset and table names', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({
    client,
    dataset: 'custom_ds',
    toolCallTable: 'custom_tool_call',
    sessionSummaryTable: 'custom_summary'
  });

  await sink.write([makeToolCallEvent(), makeSessionSummaryEvent()]);

  assert.deepEqual(
    client.inserts.map(({ dataset, table }) => ({ dataset, table })),
    [
      { dataset: 'custom_ds', table: 'custom_tool_call' },
      { dataset: 'custom_ds', table: 'custom_summary' }
    ]
  );
});

test('arguments are written as a JSON string for the JSON column', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({ client });
  const args = { a: 1, nested: { b: [1, 2] } };

  await sink.write([makeToolCallEvent({ arguments: args })]);

  const row = client.inserts[0].rows[0];
  assert.equal(typeof row.arguments, 'string');
  assert.equal(row.arguments, JSON.stringify(args));
});

test('null arguments stay null', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({ client });

  await sink.write([makeToolCallEvent({ arguments: null })]);

  assert.equal(client.inserts[0].rows[0].arguments, null);
});

test('ts is written as an ISO string', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({ client });

  await sink.write([makeToolCallEvent(), makeSessionSummaryEvent()]);

  assert.equal(client.inserts[0].rows[0].ts, '2026-09-01T23:25:24.000Z');
  assert.equal(client.inserts[1].rows[0].ts, '2026-09-01T23:25:24.000Z');
});

test('a mixed batch makes one insert() per event type', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({ client });

  await sink.write([
    makeToolCallEvent(),
    makeSessionSummaryEvent(),
    makeToolCallEvent({ tool_name: 'other-tool' })
  ]);

  assert.equal(client.inserts.length, 2);
  assert.equal(client.inserts[0].table, 'tool_call');
  assert.equal(client.inserts[0].rows.length, 2);
  assert.equal(client.inserts[1].table, 'session_summary');
  assert.equal(client.inserts[1].rows.length, 1);
});

test('an empty batch never calls insert()', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({ client });

  await sink.write([]);

  assert.equal(client.inserts.length, 0);
});
