import { AsyncLocalStorage } from 'node:async_hooks';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { instrument, consoleSink } from 'mcpsignals';
import * as z from 'zod/v4';

const notes: string[] = [];

// The MCP HTTP handler builds a fresh McpServer per request (see the SDK's
// "per-request factory" model), so instrument() runs inside the factory too
// - it's still the one required call, it just runs once per instance.
//
// flushIntervalMs: null skips the timer + beforeExit listener a per-request
// EventBuffer would otherwise leave behind forever (default mode is meant for
// one long-lived buffer, not one created per request). The factory has no way
// to hand its flush() back to the route handler directly, so this
// AsyncLocalStorage carries it out to the finally block in the /mcp route
// below.
const requestFlush = new AsyncLocalStorage<{ flush?: () => Promise<void> }>();

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });

  const { flush } = instrument(server, {
    serverName: 'notes',
    serverVersion: '1.0.0',
    sinks: [consoleSink()],
    flushIntervalMs: null
  });
  const store = requestFlush.getStore();
  if (store) store.flush = flush;

  server.registerTool(
    'add-note',
    { description: 'Append a note', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => {
      notes.push(text);
      return { content: [{ type: 'text', text: `Saved: ${text}` }] };
    }
  );

  return server;
});

const app = createMcpFastifyApp();
const node = toNodeHandler(handler);
app.all('/mcp', (request, reply) => {
  const store: { flush?: () => Promise<void> } = {};
  return requestFlush.run(store, async () => {
    try {
      await node(request.raw, reply.raw, request.body);
    } finally {
      await store.flush?.();
    }
  });
});

const port = 3001;
app.listen({ port }, () => {
  console.log(`mcpsignals node-fastify example listening on http://127.0.0.1:${port}/mcp`);
});
