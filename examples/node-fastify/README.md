# node-fastify example

A one-file MCP server (Fastify, Streamable HTTP) with `mcpsignals` wired to
the console sink, so every tool call prints as a JSON line to stdout.

## Run it

From the repo root (this is an npm workspace):

```sh
npm install
npm run start --workspace examples/node-fastify
```

Or from this directory directly:

```sh
npm install
npx tsx server.ts
```

## Try it

In another terminal:

```sh
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add-note","arguments":{"text":"hello from curl"}}}'
```

The server's terminal prints a `tool_call` event line - that's `mcpsignals`
recording the call via the console sink.
