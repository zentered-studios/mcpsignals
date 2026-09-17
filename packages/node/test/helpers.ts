import assert from 'node:assert/strict';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { instrument, type AnyEvent, type InstrumentOptions } from 'mcpsignals';

/**
 * Builds an instrumented McpServer (not yet connected) plus the events
 * recorded by a capturing sink. The v2 SDK requires every tool to be
 * registered before `connect()` is called ("Cannot register capabilities
 * after connecting to transport") — so callers register their tools on the
 * returned `server`, then call `connectClient(server)` to get a live Client
 * wired to it over an in-memory transport.
 */
export function createInstrumentedServer(instrumentOptions: Partial<InstrumentOptions> = {}) {
  const events: AnyEvent[] = [];
  const capturingSink = { write: async (batch: AnyEvent[]) => void events.push(...batch) };

  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  const handle = instrument(server, {
    serverName: 'test-server',
    serverVersion: '1.0.0',
    sinks: [capturingSink],
    bufferSize: 1, // flush immediately after every call, so tests don't need to wait
    ...instrumentOptions
  });

  return { server, events, flush: handle.flush };
}

export async function connectClient(server: McpServer) {
  const client = new Client({ name: 'test-client', version: '9.9.9' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Narrows a tool call result's first content block to text, asserting it actually is text. */
export function textOf(result: CallToolResult): string {
  const block = result.content[0];
  assert.equal(block?.type, 'text', `expected a text content block, got ${block?.type}`);
  return (block as { type: 'text'; text: string }).text;
}

/** Convenience for tests that register exactly one tool and don't need it mid-flight. */
export async function setup(
  instrumentOptions: Partial<InstrumentOptions> = {},
  registerTools?: (server: McpServer) => void
) {
  const { server, events } = createInstrumentedServer(instrumentOptions);
  if (registerTools) registerTools(server);
  const client = await connectClient(server);
  return { server, client, events };
}
