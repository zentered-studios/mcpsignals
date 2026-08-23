import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createInstrumentedServer, connectClient } from './helpers.mjs';

test('intent capture off by default: the advertised schema is unchanged', async () => {
  const { server } = createInstrumentedServer();
  server.registerTool('plain', { inputSchema: z.object({ x: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  const { tools } = await client.listTools();
  const plain = tools.find(t => t.name === 'plain');
  assert.ok(!('session_id' in plain.inputSchema.properties));
  assert.ok(!('intent' in plain.inputSchema.properties));
});

test('intent capture on: session_id/agent_id/intent are injected into the advertised schema', async () => {
  const { server } = createInstrumentedServer({ intentCapture: true });
  server.registerTool('withIntent', { inputSchema: z.object({ x: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  const { tools } = await client.listTools();
  const tool = tools.find(t => t.name === 'withIntent');
  assert.ok('session_id' in tool.inputSchema.properties);
  assert.ok('agent_id' in tool.inputSchema.properties);
  assert.ok('intent' in tool.inputSchema.properties);
  assert.ok('x' in tool.inputSchema.properties);
});

test('intent capture per-tool override: only the named tool gets the injected fields', async () => {
  const { server } = createInstrumentedServer({ intentCapture: { tools: { onlyThis: true } } });
  server.registerTool('onlyThis', { inputSchema: z.object({ x: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  server.registerTool('notThis', { inputSchema: z.object({ x: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  const { tools } = await client.listTools();
  assert.ok('intent' in tools.find(t => t.name === 'onlyThis').inputSchema.properties);
  assert.ok(!('intent' in tools.find(t => t.name === 'notThis').inputSchema.properties));
});

test('intent capture: the real handler is unaware of the injected parameters (provably transparent)', async () => {
  const { server, events } = createInstrumentedServer({ intentCapture: true });
  let receivedArgs;
  server.registerTool('withIntent2', { inputSchema: z.object({ x: z.number() }) }, async args => {
    receivedArgs = args;
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const client = await connectClient(server);

  await client.callTool({
    name: 'withIntent2',
    arguments: { x: 1, session_id: 'sess-1', agent_id: 'agent-1', intent: 'testing things' }
  });

  // The handler receives exactly what it would have received without the library: just `x`.
  assert.deepEqual(receivedArgs, { x: 1 });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events[0].session_id, 'sess-1');
  assert.equal(events[0].agent_id, 'agent-1');
  assert.equal(events[0].intent, 'testing things');
});
