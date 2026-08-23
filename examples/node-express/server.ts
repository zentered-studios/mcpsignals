import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { instrument, consoleSink } from 'mcpsignals';
import * as z from 'zod/v4';

const notes: string[] = [];

// The MCP HTTP handler builds a fresh McpServer per request (see the SDK's
// "per-request factory" model), so instrument() runs inside the factory too
// - it's still the one required call, it just runs once per instance.
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

const app = createMcpExpressApp();
const node = toNodeHandler(handler);
app.all('/mcp', (req, res) => void node(req, res, req.body));

const port = 3000;
app.listen(port, () => {
  console.log(`mcpsignals node-express example listening on http://127.0.0.1:${port}/mcp`);
});
