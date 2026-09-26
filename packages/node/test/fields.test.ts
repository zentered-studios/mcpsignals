import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer, createMcpHandler, inputRequired } from '@modelcontextprotocol/server';
import { instrument, type AnyEvent } from 'mcpsignals';
import { parseTraceparent } from '../src/trace-context.js';
import { createInstrumentedServer, connectClient } from './helpers.js';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

function echoTool(server: McpServer, annotations?: Record<string, unknown>) {
  return server.registerTool(
    'echo',
    { inputSchema: z.object({ q: z.string() }), ...(annotations && { annotations }) },
    async ({ q }) => ({ content: [{ type: 'text', text: q }] })
  );
}

test('protocol_version and request_id come from the request; result_type is complete', async () => {
  const { server, events, flush } = createInstrumentedServer();
  echoTool(server);
  const client = await connectClient(server);

  await client.callTool({ name: 'echo', arguments: { q: 'hi' } });

  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].protocol_version, server.server.getNegotiatedProtocolVersion());
  assert.ok(events[0].protocol_version);
  assert.equal(typeof events[0].request_id, 'string');
  assert.equal(events[0].result_type, 'complete');
  assert.equal(events[0].error_code, null);
});

test('trace_id and parent_span_id come from the traceparent in the request _meta', async () => {
  const { server, events, flush } = createInstrumentedServer();
  echoTool(server);
  const client = await connectClient(server);

  await client.callTool({
    name: 'echo',
    arguments: { q: 'hi' },
    _meta: { traceparent: TRACEPARENT }
  });

  await flush();
  assert.equal(events[0].trace_id, '0af7651916cd43dd8448eb211c80319c');
  assert.equal(events[0].parent_span_id, 'b7ad6b7169203331');
});

test('an invalid traceparent records null trace fields', async () => {
  const { server, events, flush } = createInstrumentedServer();
  echoTool(server);
  const client = await connectClient(server);

  await client.callTool({ name: 'echo', arguments: { q: 'hi' }, _meta: { traceparent: 'nope' } });

  await flush();
  assert.equal(events[0].trace_id, null);
  assert.equal(events[0].parent_span_id, null);
});

test('a JSON-RPC error records its code and a null result_type', async () => {
  const { server, events, flush } = createInstrumentedServer();
  echoTool(server);
  const client = await connectClient(server);

  await assert.rejects(client.callTool({ name: 'missing', arguments: {} }));

  await flush();
  assert.equal(events[0].error_code, -32602);
  assert.equal(events[0].result_type, null);
});

test('an isError result has no error_code', async () => {
  const { server, events, flush } = createInstrumentedServer();
  server.registerTool('fail', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'nope' }],
    isError: true
  }));
  const client = await connectClient(server);

  await client.callTool({ name: 'fail', arguments: {} });

  await flush();
  assert.equal(events[0].success, false);
  assert.equal(events[0].error_code, null);
  assert.equal(events[0].result_type, 'complete');
});

test('tool hints come from the registered annotations, null when undeclared', async () => {
  const { server, events, flush } = createInstrumentedServer();
  echoTool(server, { readOnlyHint: true, destructiveHint: false });
  server.registerTool('plain', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'ok' }]
  }));
  const client = await connectClient(server);

  await client.callTool({ name: 'echo', arguments: { q: 'hi' } });
  await client.callTool({ name: 'plain', arguments: {} });

  await flush();
  assert.equal(events[0].read_only_hint, true);
  assert.equal(events[0].destructive_hint, false);
  assert.equal(events[1].read_only_hint, null);
  assert.equal(events[1].destructive_hint, null);
});

test('tool hints follow RegisteredTool.update()', async () => {
  const { server, events, flush } = createInstrumentedServer();
  const tool = echoTool(server, { readOnlyHint: true });
  const client = await connectClient(server);
  tool.update({ annotations: { readOnlyHint: false, destructiveHint: true } });

  await client.callTool({ name: 'echo', arguments: { q: 'hi' } });

  await flush();
  assert.equal(events[0].read_only_hint, false);
  assert.equal(events[0].destructive_hint, true);
});

test('a rejected duplicate registerTool keeps the first registration', async () => {
  const { server, events, flush } = createInstrumentedServer();
  echoTool(server, { readOnlyHint: true });
  assert.throws(() => echoTool(server, { readOnlyHint: false }), /already registered/);
  const client = await connectClient(server);

  await client.callTool({ name: 'echo', arguments: { q: 'hi' } });

  await flush();
  assert.equal(events[0].success, true);
  assert.equal(events[0].read_only_hint, true);
});

test('tool hints follow a rename through RegisteredTool.update({ name })', async () => {
  const { server, events, flush } = createInstrumentedServer();
  const tool = echoTool(server, { readOnlyHint: true });
  const client = await connectClient(server);
  tool.update({ name: 'renamed' });

  await client.callTool({ name: 'renamed', arguments: { q: 'hi' } });
  await assert.rejects(client.callTool({ name: 'echo', arguments: { q: 'hi' } }), /not found/);

  await flush();
  assert.equal(events[0].tool_name, 'renamed');
  assert.equal(events[0].read_only_hint, true);
  assert.equal(events[1].tool_name, 'echo');
  assert.equal(events[1].success, false);
  assert.equal(events[1].read_only_hint, null);
});

test('a removed tool records null hints', async () => {
  const { server, events, flush } = createInstrumentedServer();
  const tool = echoTool(server, { readOnlyHint: true });
  const client = await connectClient(server);
  tool.remove();

  await assert.rejects(client.callTool({ name: 'echo', arguments: { q: 'hi' } }), /not found/);

  await flush();
  assert.equal(events[0].success, false);
  assert.equal(events[0].read_only_hint, null);
});

async function modernToolsCall(register: (server: McpServer) => void) {
  const events: AnyEvent[] = [];
  let flush!: () => Promise<void>;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'test-server', version: '1.0.0' });
    ({ flush } = instrument(server, {
      serverName: 'test-server',
      sinks: [{ write: async batch => void events.push(...batch) }],
      bufferSize: 1,
      flushIntervalMs: null
    }));
    register(server);
    return server;
  });
  try {
    const response = await handler.fetch(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'ask'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-7',
          method: 'tools/call',
          params: {
            name: 'ask',
            arguments: {},
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
              traceparent: TRACEPARENT
            }
          }
        })
      })
    );
    const body = await response.text();
    assert.equal(response.status, 200, body);
    await flush();
    return { events, body };
  } finally {
    await handler.close();
  }
}

test('2026-07-28: protocol_version, request_id and trace fields come from the request', async () => {
  const { events } = await modernToolsCall(server =>
    server.registerTool('ask', { inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'ok' }]
    }))
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].protocol_version, '2026-07-28');
  assert.equal(events[0].request_id, 'req-7');
  assert.equal(events[0].trace_id, '0af7651916cd43dd8448eb211c80319c');
  assert.equal(events[0].result_type, 'complete');
});

test('2026-07-28: an input_required result is recorded as result_type input_required', async () => {
  const { events, body } = await modernToolsCall(server =>
    server.registerTool('ask', { inputSchema: z.object({}) }, async () =>
      inputRequired({ requestState: 'round-1' })
    )
  );

  assert.ok(body.includes('input_required'), body);
  assert.equal(events.length, 1);
  assert.equal(events[0].result_type, 'input_required');
  assert.equal(events[0].success, true);
});

test('parseTraceparent accepts valid headers and rejects everything else', () => {
  assert.deepEqual(parseTraceparent(TRACEPARENT), {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    parentSpanId: 'b7ad6b7169203331'
  });
  // A future version may append fields.
  assert.ok(parseTraceparent(`01${TRACEPARENT.slice(2)}-extra`));
  for (const bad of [
    undefined,
    42,
    '',
    `ff${TRACEPARENT.slice(2)}`,
    `${TRACEPARENT}-extra`,
    '00-00000000000000000000000000000000-b7ad6b7169203331-01',
    '00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01',
    TRACEPARENT.toUpperCase()
  ]) {
    assert.equal(parseTraceparent(bad), null, String(bad));
  }
});
