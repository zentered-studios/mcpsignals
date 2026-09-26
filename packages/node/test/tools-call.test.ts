import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createInstrumentedServer, connectClient, textOf } from './helpers.js';

// Failures McpServer produces itself, before or after the tool callback runs.
// The client sees each of them, so each must be recorded as a failed call.

test('input validation failure: the client gets isError and a failed validation event is recorded', async () => {
  const { server, events, flush } = createInstrumentedServer();
  let handlerRan = false;
  server.registerTool('add', { inputSchema: z.object({ a: z.number() }) }, async ({ a }) => {
    handlerRan = true;
    return { content: [{ type: 'text', text: String(a) }] };
  });
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'add', arguments: { a: 'not a number' } });
  assert.equal(result.isError, true);
  assert.equal(handlerRan, false);

  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].tool_name, 'add');
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_kind, 'validation');
  assert.equal(events[0].error_message, textOf(result));
  assert.ok(events[0].request_bytes > 0);
  assert.ok(events[0].response_bytes > 0);
});

test('output validation failure: recorded as failed, matching the isError result the client gets', async () => {
  const { server, events, flush } = createInstrumentedServer();
  server.registerTool(
    'typed',
    { inputSchema: z.object({}), outputSchema: z.object({ n: z.number() }) },
    // No structuredContent: McpServer rejects the result after the callback returns.
    async () => ({ content: [{ type: 'text', text: 'oops' }] }) as never
  );
  const client = await connectClient(server);

  const result = await client.callTool({ name: 'typed', arguments: {} });
  assert.equal(result.isError, true);

  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_message, textOf(result));
});

test('unknown tool: the protocol error reaches the client unchanged and a failed not_found event is recorded', async () => {
  const { server, events, flush } = createInstrumentedServer();
  server.registerTool('known', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  await assert.rejects(client.callTool({ name: 'missing', arguments: { q: 1 } }), /missing/);

  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].tool_name, 'missing');
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_kind, 'not_found');
  assert.match(events[0].error_message ?? '', /missing/);
  assert.ok(events[0].request_bytes > 0);
  assert.equal(events[0].response_bytes, 0);
});

test('unknown tool: a client-sent name is capped at 128 chars', async () => {
  const { server, events, flush } = createInstrumentedServer();
  server.registerTool('known', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  await assert.rejects(client.callTool({ name: 'x'.repeat(500), arguments: {} }));

  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].tool_name, 'x'.repeat(128));
});

test('disabled tool: recorded as a failed call', async () => {
  const { server, events, flush } = createInstrumentedServer();
  const tool = server.registerTool('off', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  server.registerTool('on', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);
  tool.disable();

  await assert.rejects(client.callTool({ name: 'off', arguments: {} }), /disabled/);

  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].tool_name, 'off');
  assert.equal(events[0].success, false);
});

test('handler reached: exactly one event per call, not one from each layer', async () => {
  const { server, events, flush } = createInstrumentedServer({ intentCapture: true });
  server.registerTool('echo', { inputSchema: z.object({ q: z.string() }) }, async ({ q }) => ({
    content: [{ type: 'text', text: q }]
  }));
  const client = await connectClient(server);

  const result = await client.callTool({
    name: 'echo',
    arguments: { q: 'hi', intent: 'testing', agent_id: 'a1', session_id: 's1' }
  });
  assert.equal(textOf(result), 'hi');

  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].success, true);
  assert.equal(events[0].intent, 'testing');
  assert.equal(events[0].agent_id, 'a1');
  assert.equal(events[0].session_id, 's1');
});
