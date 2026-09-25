import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer, InMemoryTransport, createMcpHandler } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { ERROR_KIND_META_KEY, instrument, type AnyEvent, type InstrumentOptions } from 'mcpsignals';
import { createInstrumentedServer, connectClient, textOf } from './helpers.js';

test('success path: records a tool_call event with the right shape', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool(
    'add',
    { description: 'Add two numbers', inputSchema: z.object({ a: z.number(), b: z.number() }) },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
  );
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
  assert.equal(textOf(result), '5');

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
  const events: AnyEvent[] = [];
  const capturingSink = { write: async (batch: AnyEvent[]) => void events.push(...batch) };
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
  assert.equal(textOf(result), 'validation failed: missing field');

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_kind, 'validation');
});

test('explicit error_kind: an isError result can declare auth_required without rewording its message', async () => {
  const { server, events, flush } = createInstrumentedServer();
  server.registerTool('fee', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'Sign in at https://example.com to use this tool.' }],
    isError: true,
    _meta: { [ERROR_KIND_META_KEY]: 'auth_required' }
  }));
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'fee', arguments: {} });
  assert.equal(textOf(result), 'Sign in at https://example.com to use this tool.');

  await flush();
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_kind, 'auth_required');
});

test('explicit error_kind: an isError result can declare payment_required', async () => {
  const { server, events, flush } = createInstrumentedServer();
  server.registerTool('fee', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'Get filing fee requires an active plan.' }],
    isError: true,
    _meta: { [ERROR_KIND_META_KEY]: 'payment_required' }
  }));
  const client = await connectClient(server);

  await client.callTool({ name: 'fee', arguments: {} });

  await flush();
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_kind, 'payment_required');
});

test('explicit error_kind: a declared kind wins over the message heuristic', async () => {
  const { server, events, flush } = createInstrumentedServer();
  server.registerTool('fee', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'No current fee on file for that form.' }],
    isError: true,
    _meta: { [ERROR_KIND_META_KEY]: 'not_found' }
  }));
  const client = await connectClient(server);

  await client.callTool({ name: 'fee', arguments: {} });

  await flush();
  assert.equal(events[0].error_kind, 'not_found');
});

test('explicit error_kind: an unknown declared kind falls back to the message heuristic', async () => {
  const { server, events, flush } = createInstrumentedServer();
  server.registerTool('fee', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'widget not found' }],
    isError: true,
    _meta: { [ERROR_KIND_META_KEY]: 'teapot' }
  }));
  const client = await connectClient(server);

  await client.callTool({ name: 'fee', arguments: {} });

  await flush();
  assert.equal(events[0].error_kind, 'not_found');
});

test('explicit error_kind: a declared kind on a successful result is ignored', async () => {
  const { server, events, flush } = createInstrumentedServer();
  server.registerTool('fee', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'ok' }],
    _meta: { [ERROR_KIND_META_KEY]: 'auth_required' }
  }));
  const client = await connectClient(server);

  await client.callTool({ name: 'fee', arguments: {} });

  await flush();
  assert.equal(events[0].success, true);
  assert.equal(events[0].error_kind, null);
});

test('explicit error_kind: a _meta that throws on read still records the failed call', async t => {
  t.mock.method(console, 'error', () => {});
  const { server, events, flush } = createInstrumentedServer();
  const throwingMeta = new Proxy(
    {},
    {
      get(target, key) {
        if (key === ERROR_KIND_META_KEY) throw new Error('boom');
        return Reflect.get(target, key);
      }
    }
  );
  server.registerTool('fee', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'widget not found' }],
    isError: true,
    _meta: throwingMeta
  }));
  const client = await connectClient(server);

  await client.callTool({ name: 'fee', arguments: {} });

  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_kind, 'not_found');
});

test('transparency: the real handler receives exactly the arguments it would have without the library', async () => {
  const { server } = createInstrumentedServer();
  let receivedArgs: unknown;
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
  assert.equal(textOf(result), 'pong');

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
  let received: unknown;
  server.registerTool('whoami', { description: 'no schema' }, async ctx => {
    received = ctx;
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const client = await connectClient(server);

  await client.callTool({ name: 'whoami', arguments: { ignored: true } });
  assert.equal(typeof received, 'object');
  assert.ok(
    typeof received === 'object' && received !== null && !('ignored' in received),
    'handler must not receive the raw arguments as ctx'
  );
});

test('no inputSchema: a thrown error is recorded as a failed event and the client still gets isError:true', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool('boom-noschema', { description: 'no schema' }, async () => {
    throw new Error('widget not found');
  });
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'boom-noschema', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'widget not found');

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
  assert.ok(advertised, 'the ping-intent tool must be advertised');
  const properties = advertised.inputSchema.properties as Record<string, unknown> | undefined;
  assert.ok(properties?.intent, 'intent field is injected into the schema');

  const result = await client.callTool({
    name: 'ping-intent',
    arguments: { intent: 'health check', session_id: 's-1' }
  });
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), 'pong');

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].success, true);
  assert.equal(events[0].intent, 'health check');
  assert.equal(events[0].session_id, 's-1');
});

/**
 * `close()` tests build their own server so each one can measure the
 * `beforeExit` listener count around exactly one `instrument()` call.
 */
function createClosableServer(instrumentOptions: Partial<InstrumentOptions> = {}) {
  const events: AnyEvent[] = [];
  const capturingSink = { write: async (batch: AnyEvent[]) => void events.push(...batch) };
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  const handle = instrument(server, {
    serverName: 'test-server',
    sinks: [capturingSink],
    bufferSize: 100, // a single tool call never triggers an auto-flush
    ...instrumentOptions
  });
  server.registerTool(
    'add',
    { inputSchema: z.object({ a: z.number(), b: z.number() }) },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
  );
  return { server, events, handle };
}

test('close(): default mode removes exactly the one beforeExit listener instrument() added', async () => {
  const before = process.listenerCount('beforeExit');
  const { handle } = createClosableServer({ flushIntervalMs: 60_000 });
  assert.equal(process.listenerCount('beforeExit'), before + 1);

  await handle.close();
  assert.equal(process.listenerCount('beforeExit'), before);
});

test('close(): flushes the pending batch before stopping', async () => {
  const { server, events, handle } = createClosableServer({ flushIntervalMs: 60_000 });
  const client = await connectClient(server);

  await client.callTool({ name: 'add', arguments: { a: 2, b: 3 } });
  assert.equal(events.length, 0, 'below bufferSize and the interval has not fired');

  await handle.close();
  assert.equal(events.length, 1);
  assert.equal(events[0].tool_name, 'add');
});

test('close(): calling it twice does not throw and does not remove a second listener', async () => {
  const before = process.listenerCount('beforeExit');
  const { handle } = createClosableServer({ flushIntervalMs: 60_000 });

  await handle.close();
  await handle.close();
  assert.equal(process.listenerCount('beforeExit'), before);
});

test('close(): manual mode flushes and leaves the beforeExit listener count unchanged', async () => {
  const before = process.listenerCount('beforeExit');
  const { server, events, handle } = createClosableServer({ flushIntervalMs: null });
  assert.equal(process.listenerCount('beforeExit'), before);
  const client = await connectClient(server);

  await client.callTool({ name: 'add', arguments: { a: 1, b: 1 } });
  assert.equal(events.length, 0);

  await handle.close();
  assert.equal(events.length, 1);
  assert.equal(process.listenerCount('beforeExit'), before);
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
    assert.equal(textOf(first), 'ok');
    const second = await client.callTool({
      name: 'lookup-redact',
      arguments: { email: 'jane@example.com' }
    });
    assert.equal(second.isError, undefined);
    assert.equal(textOf(second), 'ok');

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
    assert.equal(textOf(first), 'ok');
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
    assert.equal(textOf(result), '42');

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
  const order: string[] = [];
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
  assert.equal(textOf(result), 'ok');

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

// Identity: `resolveIdentity` may return the identity directly or as a
// promise. The async path is asserted in the duration test above; this pins
// the sync path and that the resolver sees the call's session id slot.

test('resolveIdentity: a synchronous resolver lands user_id and org_id on the event', async () => {
  const seen: { sessionId?: string }[] = [];
  const { server, events } = createInstrumentedServer({
    resolveIdentity: ctx => {
      seen.push(ctx);
      return { userId: 'u-sync', orgId: 'o-sync' };
    }
  });
  server.registerTool('whoami-sync', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'whoami-sync', arguments: {} });
  assert.equal(textOf(result), 'ok');

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  assert.equal(events[0].user_id, 'u-sync');
  assert.equal(events[0].org_id, 'o-sync');
  assert.equal(seen.length, 1);
  assert.ok('sessionId' in seen[0], 'the resolver receives the { sessionId } context');
});

// Transport: the SDK sets `ctx.http` on the tool callback context only when
// the call arrived over its HTTP handler, and the wrapper maps that to
// `transport: 'http'`. Driven through the real web-standard handler
// (`createMcpHandler(...).fetch(Request)`) with the same JSON-RPC body the
// example READMEs send with curl, so the branch is exercised end to end.

test('transport: a tools/call over the SDK HTTP handler is recorded as transport: "http"', async () => {
  const events: AnyEvent[] = [];
  const capturingSink = { write: async (batch: AnyEvent[]) => void events.push(...batch) };
  // Definite assignment: set synchronously by the factory below, before any
  // request (and so any read of `flush`) can reach it.
  let flush!: () => Promise<void>;
  const handler = createMcpHandler(() => {
    // Per-request factory, as in examples/node-express/server.ts: a fresh
    // McpServer, instrumented in manual flush mode, per HTTP request.
    const server = new McpServer({ name: 'test-server', version: '1.0.0' });
    ({ flush } = instrument(server, {
      serverName: 'test-server',
      sinks: [capturingSink],
      bufferSize: 1,
      flushIntervalMs: null
    }));
    server.registerTool(
      'add-note',
      { inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: 'text', text: `Saved: ${text}` }] })
    );
    return server;
  });

  try {
    const response = await handler.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'add-note', arguments: { text: 'hello from curl' } }
        })
      })
    );
    assert.equal(response.status, 200);
    const body = await response.text(); // JSON or an SSE frame, depending on the SDK's response mode
    assert.ok(body.includes('Saved: hello from curl'), `unexpected response body: ${body}`);

    await flush();
    assert.equal(events.length, 1);
    assert.equal(events[0].tool_name, 'add-note');
    assert.equal(events[0].success, true);
    assert.equal(events[0].transport, 'http');
  } finally {
    await handler.close();
  }
});

test('byte sizes: request_bytes/response_bytes are UTF-8 byte counts of the JSON, not string lengths', async () => {
  const { server, events } = createInstrumentedServer();
  server.registerTool(
    'greet',
    { inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => ({ content: [{ type: 'text', text: `hi ${name} \u{1F44B}` }] })
  );
  const client = await connectClient(server);

  const args = { name: 'Zoë \u{1F600}' }; // multi-byte characters: byte count != string length
  const result = await client.callTool({ name: 'greet', arguments: args });
  await new Promise(resolve => setTimeout(resolve, 10));

  const encoder = new TextEncoder();
  const expectedRequest = encoder.encode(JSON.stringify(args)).length;
  const expectedResponse = encoder.encode(JSON.stringify(result)).length;
  assert.notEqual(
    expectedRequest,
    JSON.stringify(args).length,
    'fixture must contain multi-byte chars'
  );
  assert.equal(events[0].request_bytes, expectedRequest);
  assert.equal(events[0].response_bytes, expectedResponse);
});

test('runtime portability: a tool call succeeds with globalThis.Buffer absent (Workers without nodejs_compat)', async () => {
  const savedBuffer = globalThis.Buffer;
  try {
    // @ts-expect-error - simulating a runtime where Buffer was never defined
    delete globalThis.Buffer;
    assert.equal(
      typeof Buffer,
      'undefined',
      'Buffer must be unreachable for this test to mean anything'
    );

    const { server, events } = createInstrumentedServer();
    server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'pong' }]
    }));
    const client = await connectClient(server);

    const result = await client.callTool({ name: 'ping', arguments: {} });
    assert.notEqual(result.isError, true, 'the wrapper must not throw when Buffer is undefined');
    assert.equal(textOf(result), 'pong');

    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(events.length, 1);
    assert.equal(events[0].success, true);
    assert.ok(events[0].request_bytes > 0);
    assert.ok(events[0].response_bytes > 0);
  } finally {
    globalThis.Buffer = savedBuffer;
  }
});
