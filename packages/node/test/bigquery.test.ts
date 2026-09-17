import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bigquerySink, type ToolCallEvent } from 'mcpsignals';

function makeToolCallEvent(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
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

interface RecordedInsert {
  dataset: string;
  table: string;
  rows: Record<string, unknown>[];
}

// A minimal fake matching the @google-cloud/bigquery surface the sink relies
// on: client.dataset(name).table(name).insert(rows). Each insert() call is
// recorded with the dataset and table it targeted.
function makeFakeClient() {
  const inserts: RecordedInsert[] = [];
  return {
    inserts,
    dataset(datasetName: string) {
      return {
        table(tableName: string) {
          return {
            async insert(rows: Record<string, unknown>[]) {
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

  await sink.write([makeToolCallEvent()]);

  assert.deepEqual(
    client.inserts.map(({ dataset, table }) => ({ dataset, table })),
    [{ dataset: 'mcpsignals', table: 'tool_call' }]
  );
});

test('respects custom dataset and table names', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({
    client,
    dataset: 'custom_ds',
    toolCallTable: 'custom_tool_call'
  });

  await sink.write([makeToolCallEvent()]);

  assert.deepEqual(
    client.inserts.map(({ dataset, table }) => ({ dataset, table })),
    [{ dataset: 'custom_ds', table: 'custom_tool_call' }]
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

  await sink.write([makeToolCallEvent()]);

  assert.equal(client.inserts[0].rows[0].ts, '2026-09-01T23:25:24.000Z');
});

test('a batch makes exactly one insert() for the whole batch', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({ client });

  await sink.write([makeToolCallEvent(), makeToolCallEvent({ tool_name: 'other-tool' })]);

  assert.equal(client.inserts.length, 1);
  assert.equal(client.inserts[0].table, 'tool_call');
  assert.equal(client.inserts[0].rows.length, 2);
});

test('an empty batch never calls insert()', async () => {
  const client = makeFakeClient();
  const sink = bigquerySink({ client });

  await sink.write([]);

  assert.equal(client.inserts.length, 0);
});
