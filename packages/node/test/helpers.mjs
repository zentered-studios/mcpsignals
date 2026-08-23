import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { instrument } from '../dist/index.mjs';

/**
 * Builds an instrumented McpServer (not yet connected) plus the events
 * recorded by a capturing sink. The v2 SDK requires every tool to be
 * registered before `connect()` is called ("Cannot register capabilities
 * after connecting to transport") — so callers register their tools on the
 * returned `server`, then call `connectClient(server)` to get a live Client
 * wired to it over an in-memory transport.
 */
export function createInstrumentedServer(instrumentOptions = {}) {
  const events = [];
  const capturingSink = { write: async batch => void events.push(...batch) };

  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  instrument(server, {
    serverName: 'test-server',
    serverVersion: '1.0.0',
    sinks: [capturingSink],
    bufferSize: 1, // flush immediately after every call, so tests don't need to wait
    ...instrumentOptions
  });

  return { server, events };
}

export async function connectClient(server) {
  const client = new Client({ name: 'test-client', version: '9.9.9' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Convenience for tests that register exactly one tool and don't need it mid-flight. */
export async function setup(instrumentOptions = {}, registerTools) {
  const { server, events } = createInstrumentedServer(instrumentOptions);
  if (registerTools) registerTools(server);
  const client = await connectClient(server);
  return { server, client, events };
}
