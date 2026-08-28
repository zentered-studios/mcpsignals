# mcpsignals (Node.js)

Drop-in instrumentation for MCP servers. Wrap your server, point it at a
sink, and it records what agents did with your tools into a database you
own - no hosted service, no account, no per-session pricing.

Requires **Node.js 20 or newer**. See the [root README](../../README.md) for
the redaction model, the sink comparison, and intent capture, and
[`schema/events.md`](../../schema/events.md) for the event field reference.

## Install

```bash
npm install mcpsignals @modelcontextprotocol/server zod
```

`@modelcontextprotocol/server` (v2) and `zod` are peer dependencies - you
already have them if you have an MCP server. Warehouse clients (`pg`,
`@google-cloud/bigquery`, `@opentelemetry/api`) are optional peer
dependencies: only install the one for the sink you use.

## Usage

`instrument()` wraps `registerTool` itself, so it must be called **right
after constructing your server and before registering any tools**.

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { instrument, consoleSink } from 'mcpsignals';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

instrument(server, {
  serverName: 'my-server',
  serverVersion: '1.0.0',
  sinks: [consoleSink()]
});

server.registerTool(/* ...as normal, nothing else changes... */);
```

Argument capture is off by default. Turn it on and record only key names
and value types with:

```ts
instrument(server, {
  serverName: 'my-server',
  sinks: [consoleSink()],
  captureArguments: true
});
```

See the root README's redaction section before enabling `redaction.allow`
to record real argument values.

## Request-scoped runtimes (Cloudflare Workers)

`instrument()` returns a handle: `{ server, flush(): Promise<void> }`. On a
long-lived Node process, ignore it - the interval timer and the
`beforeExit` listener flush for you. On a request-scoped, isolate-based
runtime, neither of those is reliable: the isolate can be evicted the
instant the response is sent, with no guarantee a `setInterval` fires again
before that happens, and `process`'s `beforeExit` doesn't correspond to "this
invocation is ending" outside Node.

Pass `flushIntervalMs: null` to disable the timer and the `beforeExit`
listener entirely, construct the server fresh per request (the correct
pattern here regardless, so a module-scope server doesn't close over one
request's auth context), and flush explicitly via `ctx.waitUntil()` before
returning:

```ts
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { instrument, consoleSink } from 'mcpsignals';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });
    const { flush } = instrument(server, {
      serverName: 'my-server',
      sinks: [consoleSink()],
      flushIntervalMs: null // manual mode: no timer, no beforeExit listener
    });

    server.registerTool(/* ...as normal... */);

    // ...connect server to your transport and handle the request...

    ctx.waitUntil(flush());
    return response;
  }
};
```

## Sinks

```ts
import { postgresSink, bigquerySink, otlpSink } from 'mcpsignals';
```

Each sink pulls credentials from its own client library's usual defaults
(env vars, Application Default Credentials, or the global OTel
TracerProvider) - there's no mcpsignals-specific config file.
