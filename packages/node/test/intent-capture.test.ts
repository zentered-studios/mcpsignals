import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/client';
import { createInstrumentedServer, connectClient } from './helpers.js';

/** Asserts the tool was found and returns its advertised input schema properties. */
function propertiesOf(tool: Tool | undefined): Record<string, unknown> {
  assert.ok(tool, 'expected the tool to be advertised');
  return (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
}

test('intent capture off by default: the advertised schema is unchanged', async () => {
  const { server } = createInstrumentedServer();
  server.registerTool('plain', { inputSchema: z.object({ x: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  const { tools } = await client.listTools();
  const plain = propertiesOf(tools.find(t => t.name === 'plain'));
  assert.ok(!('session_id' in plain));
  assert.ok(!('intent' in plain));
});

test('intent capture on: session_id/agent_id/intent are injected into the advertised schema', async () => {
  const { server } = createInstrumentedServer({ intentCapture: true });
  server.registerTool('withIntent', { inputSchema: z.object({ x: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  const { tools } = await client.listTools();
  const properties = propertiesOf(tools.find(t => t.name === 'withIntent'));
  assert.ok('session_id' in properties);
  assert.ok('agent_id' in properties);
  assert.ok('intent' in properties);
  assert.ok('x' in properties);
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
  assert.ok('intent' in propertiesOf(tools.find(t => t.name === 'onlyThis')));
  assert.ok(!('intent' in propertiesOf(tools.find(t => t.name === 'notThis'))));
});

test('intent capture: the real handler is unaware of the injected parameters (provably transparent)', async () => {
  const { server, events } = createInstrumentedServer({ intentCapture: true });
  let receivedArgs: unknown;
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

test('intent capture: oversized caller-supplied fields are truncated before they reach a sink', async () => {
  const { server, events } = createInstrumentedServer({ intentCapture: true });
  server.registerTool('withIntent3', { inputSchema: z.object({ x: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  await client.callTool({
    name: 'withIntent3',
    arguments: {
      x: 1,
      session_id: 's'.repeat(5000),
      agent_id: 'a'.repeat(5000),
      intent: 'i'.repeat(5000)
    }
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  // Identifiers take the tighter cap; intent takes the same 2000 as error_message.
  assert.equal(events[0].session_id, 's'.repeat(128));
  assert.equal(events[0].agent_id, 'a'.repeat(128));
  assert.equal(events[0].intent, 'i'.repeat(2000));
});

test('intent capture: truncation never splits a surrogate pair at the boundary', async () => {
  const { server, events } = createInstrumentedServer({ intentCapture: true });
  server.registerTool('withIntent5', { inputSchema: z.object({ x: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  // An astral character (2 UTF-16 code units, e.g. an emoji) whose pair
  // straddles the cap: a naive slice(0, cap) would keep only the high
  // surrogate, leaving an invalid lone surrogate in the truncated string.
  const emoji = '\u{1F600}';
  const sessionId = 'a'.repeat(127) + emoji; // length 129, cap 128
  const intent = 'i'.repeat(1999) + emoji; // length 2001, cap 2000

  await client.callTool({
    name: 'withIntent5',
    arguments: { x: 1, session_id: sessionId, agent_id: 'agent-1', intent }
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  for (const value of [events[0].session_id, events[0].intent]) {
    assert.ok(value);
    // No lone surrogate anywhere in the truncated value.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
      if (isHighSurrogate) {
        assert.ok(i + 1 < value.length, `lone high surrogate at end of ${JSON.stringify(value)}`);
        const next = value.charCodeAt(i + 1);
        assert.ok(
          next >= 0xdc00 && next <= 0xdfff,
          `unpaired high surrogate in ${JSON.stringify(value)}`
        );
      }
    }
  }
  assert.equal(events[0].session_id, 'a'.repeat(127));
  assert.equal(events[0].intent, 'i'.repeat(1999));
});

test('intent capture: values within the caps reach the sink unchanged', async () => {
  const { server, events } = createInstrumentedServer({ intentCapture: true });
  server.registerTool('withIntent4', { inputSchema: z.object({ x: z.number() }) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  await client.callTool({
    name: 'withIntent4',
    arguments: {
      x: 1,
      session_id: '019609c8-1f57-7000-8000-a1b2c3d4e5f6',
      agent_id: 'agent-1',
      intent: 'i'.repeat(2000)
    }
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events[0].session_id, '019609c8-1f57-7000-8000-a1b2c3d4e5f6');
  assert.equal(events[0].agent_id, 'agent-1');
  assert.equal(events[0].intent?.length, 2000);
});
