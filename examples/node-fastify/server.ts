import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { instrument, consoleSink } from 'mcpsignals';
import * as z from 'zod/v4';

const notes: string[] = [];

// createMcpHandler builds a fresh McpServer per request, so instrument()
// runs inside the factory too - it's still the one required call, it just
// runs once per instance rather than once at module load.
const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });

  instrument(server, {
    serverName: 'notes',
    serverVersion: '1.0.0',
    sinks: [consoleSink()]
  });

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
app.all('/mcp', (request, reply) => node(request.raw, reply.raw, request.body));

const port = 3001;
app.listen({ port }, () => {
  console.log(`mcpsignals node-fastify example listening on http://127.0.0.1:${port}/mcp`);
});
