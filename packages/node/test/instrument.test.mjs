import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { instrument } from '../dist/index.mjs';
import { createInstrumentedServer, connectClient } from './helpers.mjs';

test('success path: records a tool_call event with the right shape', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool(
    'add',
    { description: 'Add two numbers', inputSchema: z.object({ a: z.number(), b: z.number() }) },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
  );
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
  assert.equal(result.content[0].text, '5');

  await new Promise(resolve => setTimeout(resolve, 10)); // let the buffer's async flush land
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.event_type, 'tool_call');
  assert.equal(event.tool_name, 'add');
  assert.equal(event.server_name, 'test-server');
  assert.equal(event.server_version, '1.0.0');
  assert.equal(event.client_name, 'test-client');
  assert.equal(event.client_version, '9.9.9');
  assert.equal(event.success, true);
  assert.equal(event.error_kind, null);
  assert.equal(event.error_message, null);
  assert.equal(event.transport, 'stdio'); // in-memory transport carries no http info
  assert.ok(event.duration_ms >= 0);
  assert.ok(event.request_bytes > 0);
  assert.ok(event.response_bytes > 0);
  assert.equal(event.arguments, null); // captureArguments defaults to false
});

test('flush handle: instrument() returns { server, flush } and flush() delivers buffered events immediately', async () => {
  const events = [];
  const capturingSink = { write: async batch => void events.push(...batch) };
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  const handle = instrument(server, {
    serverName: 'test-server',
    sinks: [capturingSink],
    bufferSize: 100, // high enough that a tool call alone never triggers an auto-flush
    flushIntervalMs: null // manual mode: only handle.flush() delivers events
  });
  assert.equal(handle.server, server);

  server.registerTool(
    'add',
    { inputSchema: z.object({ a: z.number(), b: z.number() }) },
    async ({ a, b }) => ({
      content: [{ type: 'text', text: String(a + b) }]
    })
  );
  const client = await connectClient(server);

  await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
  assert.equal(
    events.length,
    0,
    'nothing should be flushed yet: below bufferSize, no interval, flush() not called'
  );

  await handle.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].tool_name, 'add');
});

test('error path: a thrown error is unchanged for the caller and recorded as a failed event', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool('boom', { inputSchema: z.object({}) }, async () => {
    throw new Error('widget not found');
  });
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'boom', arguments: {} });
  // McpServer's own handling converts the throw into isError:true for the client —
  // that conversion is unrelated to instrumentation and must be unchanged by it.
  assert.equal(result.isError, true);

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_kind, 'not_found');
  assert.equal(events[0].error_message, 'widget not found');
});

test('error path: a handler-returned isError:true result is recorded as a failed event', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool('reject', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'validation failed: missing field' }],
    isError: true
  }));
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'reject', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'validation failed: missing field');

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_kind, 'validation');
});

test('transparency: the real handler receives exactly the arguments it would have without the library', async () => {
  const { server } = createInstrumentedServer();
  let receivedArgs;
  server.registerTool('echo', { inputSchema: z.object({ value: z.string() }) }, async args => {
    receivedArgs = args;
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const client = await connectClient(server);

  await client.callTool({ name: 'echo', arguments: { value: 'hi' } });
  assert.deepEqual(receivedArgs, { value: 'hi' });
});

test('redaction default: capture on, no config -> keys and value types only, never real values', async () => {
  const { server, events } = createInstrumentedServer({ captureArguments: true });
  server.registerTool(
    'lookup',
    { inputSchema: z.object({ email: z.string(), count: z.number() }) },
    async () => ({ content: [{ type: 'text', text: 'ok' }] })
  );
  const client = await connectClient(server);

  await client.callTool({ name: 'lookup', arguments: { email: 'jane@example.com', count: 3 } });
  await new Promise(resolve => setTimeout(resolve, 10));

  const recorded = events[0].arguments;
  assert.deepEqual(recorded, { email: { __type: 'string' }, count: { __type: 'number' } });
  assert.ok(!JSON.stringify(recorded).includes('jane@example.com'));
});

test('redaction allowlist: only allow-listed keys keep their real value', async () => {
  const { server, events } = createInstrumentedServer({
    captureArguments: true,
    redaction: { allow: ['count'] }
  });
  server.registerTool(
    'lookup2',
    { inputSchema: z.object({ email: z.string(), count: z.number() }) },
    async () => ({ content: [{ type: 'text', text: 'ok' }] })
  );
  const client = await connectClient(server);

  await client.callTool({ name: 'lookup2', arguments: { email: 'jane@example.com', count: 3 } });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(events[0].arguments, { email: { __type: 'string' }, count: 3 });
});

test('redaction: captureArguments false never records arguments, regardless of redaction config', async () => {
  const { server, events } = createInstrumentedServer({
    captureArguments: false,
    redaction: { allow: ['count'] }
  });
  server.registerTool('lookup3', { inputSchema: z.object({ count: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  await client.callTool({ name: 'lookup3', arguments: { count: 3 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events[0].arguments, null);
});

test('no inputSchema: the handler result reaches the client and one success event is recorded', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool('ping', { description: 'no schema' }, async () => ({
    content: [{ type: 'text', text: 'pong' }]
  }));
  // Same tool with an empty schema: the schema-less event must be recorded
  // exactly as an empty-arguments call, whatever byteLength({}) is.
  server.registerTool('ping-empty-schema', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'pong' }]
  }));
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'ping', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'pong');

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].tool_name, 'ping');
  assert.equal(events[0].success, true);
  assert.equal(events[0].error_message, null);
  assert.ok(events[0].response_bytes > 0);

  await client.callTool({ name: 'ping-empty-schema', arguments: {} });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 2);
  assert.equal(events[0].request_bytes, events[1].request_bytes);
});

test('no inputSchema: the handler receives the ctx the SDK passes, not the arguments', async () => {
  const { server } = createInstrumentedServer();
  let received;
  server.registerTool('whoami', { description: 'no schema' }, async ctx => {
    received = ctx;
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const client = await connectClient(server);

  await client.callTool({ name: 'whoami', arguments: { ignored: true } });
  assert.equal(typeof received, 'object');
  assert.ok(received !== null);
  assert.ok(!('ignored' in received), 'handler must not receive the raw arguments as ctx');
});

test('no inputSchema: a thrown error is recorded as a failed event and the client still gets isError:true', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool('boom-noschema', { description: 'no schema' }, async () => {
    throw new Error('widget not found');
  });
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'boom-noschema', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'widget not found');

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].tool_name, 'boom-noschema');
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_kind, 'not_found');
  assert.equal(events[0].error_message, 'widget not found');
});

test('no inputSchema + intentCapture: the injected schema path still works and records intent', async () => {
  const { server, events } = createInstrumentedServer({ intentCapture: true });
  server.registerTool('ping-intent', { description: 'no schema' }, async () => ({
    content: [{ type: 'text', text: 'pong' }]
  }));
  const client = await connectClient(server);

  const { tools } = await client.listTools();
  const advertised = tools.find(t => t.name === 'ping-intent');
  assert.ok(advertised.inputSchema.properties.intent, 'intent field is injected into the schema');

  const result = await client.callTool({
    name: 'ping-intent',
    arguments: { intent: 'health check', session_id: 's-1' }
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'pong');

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].success, true);
  assert.equal(events[0].intent, 'health check');
  assert.equal(events[0].session_id, 's-1');
});

// Telemetry failure isolation (#25): nothing the library does around a tool
// call may change what the client receives. Each test below breaks one
// library-side step and asserts the handler's own result still comes back,
// the event still lands, and the failure is logged once per instrument() call.

test('telemetry failure: a throwing redactor never reaches the client; the event is recorded with arguments: null and logged once', async () => {
  const errorLog = mock.method(console, 'error', () => {});
  try {
    const { server, events } = createInstrumentedServer({
      captureArguments: true,
      redaction: {
        redactor: () => {
          throw new Error('redactor exploded');
        }
      }
    });
    server.registerTool(
      'lookup-redact',
      { inputSchema: z.object({ email: z.string() }) },
      async () => ({ content: [{ type: 'text', text: 'ok' }] })
    );
    const client = await connectClient(server);

    const first = await client.callTool({
      name: 'lookup-redact',
      arguments: { email: 'jane@example.com' }
    });
    assert.equal(first.isError, undefined);
    assert.equal(first.content[0].text, 'ok');
    const second = await client.callTool({
      name: 'lookup-redact',
      arguments: { email: 'jane@example.com' }
    });
    assert.equal(second.isError, undefined);
    assert.equal(second.content[0].text, 'ok');

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.success, true);
      // A failed redactor must never fall back to the raw arguments.
      assert.equal(event.arguments, null);
    }
    assert.ok(!JSON.stringify(events).includes('jane@example.com'));
    assert.equal(errorLog.mock.callCount(), 1, 'logged once per instrument() call, not per event');
  } finally {
    errorLog.mock.restore();
  }
});

test('telemetry failure: a throwing resolveIdentity never reaches the client; the event is recorded with null identity', async () => {
  const errorLog = mock.method(console, 'error', () => {});
  try {
    const { server, events } = createInstrumentedServer({
      resolveIdentity: () => {
        throw new Error('identity service down');
      }
    });
    server.registerTool('whoami-id', { inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'ok' }]
    }));
    const client = await connectClient(server);

    const first = await client.callTool({ name: 'whoami-id', arguments: {} });
    assert.equal(first.isError, undefined);
    assert.equal(first.content[0].text, 'ok');
    const second = await client.callTool({ name: 'whoami-id', arguments: {} });
    assert.equal(second.isError, undefined);

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.success, true);
      assert.equal(event.user_id, null);
      assert.equal(event.org_id, null);
    }
    assert.equal(errorLog.mock.callCount(), 1);
  } finally {
    errorLog.mock.restore();
  }
});

test('telemetry failure: a BigInt argument cannot be JSON-serialized, but the handler still runs and the client gets its result', async () => {
  const errorLog = mock.method(console, 'error', () => {});
  try {
    const { server, events } = createInstrumentedServer();
    // The in-memory transport passes the request object through by reference,
    // so a real BigInt reaches the wrapper and `JSON.stringify` throws on it.
    server.registerTool('big', { inputSchema: z.object({ n: z.bigint() }) }, async ({ n }) => ({
      content: [{ type: 'text', text: String(n * 2n) }]
    }));
    const client = await connectClient(server);

    const result = await client.callTool({ name: 'big', arguments: { n: 21n } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, '42');

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.length, 1);
    assert.equal(events[0].success, true);
    assert.equal(events[0].request_bytes, 0, 'unmeasurable request size is recorded as 0');
    assert.equal(errorLog.mock.callCount(), 1);
  } finally {
    errorLog.mock.restore();
  }
});

// Timing (#27): `duration_ms` is wall time from call start to response
// (schema/events.md), so `resolveIdentity` runs after the handler, outside
// the timed window. `ts` stays anchored at call start.

test('duration_ms excludes resolveIdentity: a 200 ms resolver plus an instant tool records well under 100 ms', async () => {
  const order = [];
  const { server, events } = createInstrumentedServer({
    resolveIdentity: async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      order.push('resolver');
      return { userId: 'u-1', orgId: 'o-1' };
    }
  });
  server.registerTool('instant', { inputSchema: z.object({}) }, async () => {
    order.push('handler');
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'instant', arguments: {} });
  assert.equal(result.content[0].text, 'ok');

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.ok(
    events[0].duration_ms < 100,
    `duration_ms ${events[0].duration_ms} includes the 200 ms identity resolver`
  );
  // The resolver still ran, after the handler, and its result lands on the event.
  assert.deepEqual(order, ['handler', 'resolver']);
  assert.equal(events[0].user_id, 'u-1');
  assert.equal(events[0].org_id, 'o-1');
});

test('ts is when the call started, not when it finished', async () => {
  let handlerSawAt = 0;
  const { server, events } = createInstrumentedServer();
  server.registerTool('slow', { inputSchema: z.object({}) }, async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    handlerSawAt = Date.now();
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const client = await connectClient(server);

  await client.callTool({ name: 'slow', arguments: {} });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.ok(events[0].ts instanceof Date);
  assert.ok(
    events[0].ts.getTime() <= handlerSawAt - 40,
    `ts ${events[0].ts.toISOString()} is not at least 40 ms before the handler finished at ${new Date(handlerSawAt).toISOString()}`
  );
});

// Bounds (#19): `client_name`/`client_version` come from the client's
// `initialize` handshake, so they are caller-controlled like the intent
// fields and take the same 128-char identifier cap. Truncated, never dropped.

test('client_name and client_version are truncated to 128 chars, never dropped', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = new Client({ name: 'c'.repeat(5000), version: 'v'.repeat(5000) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({ name: 'ping', arguments: {} });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].client_name, 'c'.repeat(128));
  assert.equal(events[0].client_version, 'v'.repeat(128));
});

test('client_name and client_version within the cap reach the sink unchanged', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  await client.callTool({ name: 'ping', arguments: {} });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events[0].client_name, 'test-client');
  assert.equal(events[0].client_version, '9.9.9');
});
