import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
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
