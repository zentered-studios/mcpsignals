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

On a stdio transport pass `consoleSink({ stream: process.stderr })`, because
the MCP spec reserves stdout for protocol messages and `StdioServerTransport`
writes to the same `process.stdout` the default sink uses.

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

## Identity: `user_id` and `org_id`

`resolveIdentity` is the only thing that ever fills in `user_id` and
`org_id`. Without it both stay null on every event.

```ts
instrument(server, {
  serverName: 'my-server',
  sinks: [consoleSink()],
  resolveIdentity: ({ sessionId }) => {
    const account = lookUpAccount(sessionId); // your auth layer, not ours
    return account && { userId: account.id, orgId: account.orgId };
  }
});
```

It receives `{ sessionId }` and returns `{ userId?, orgId? }`, `undefined`,
or a promise of either. Returning nothing records a null identity, which is
what the column means for an anonymous call.

It runs **after** your handler settles, so a slow resolver never lands in
`duration_ms` (wall time from call start to response, per
[`schema/events.md`](../../schema/events.md)). A resolver that throws or
rejects is logged once and costs you the identity on that event, nothing
else: the event is still recorded, and your handler's result or exception
reaches the client untouched.

`sessionId` here comes from the transport context only. With intent capture
on, a calling agent can supply its own `session_id`, and the event records
that value while the resolver still sees `undefined` for it. On a stdio
transport, where there is no transport session id, that means the event can
carry a session id the resolver never saw. Do not key identity off
`sessionId` alone if you rely on intent-capture session ids.

## Buffering and flush timing

Events are batched in memory rather than written one per call.
`bufferSize` (default 20) flushes after that many events; `flushIntervalMs`
(default 5000) flushes on a timer. Whichever comes first wins, plus a
best-effort flush on `beforeExit`.

```ts
instrument(server, {
  serverName: 'my-server',
  sinks: [postgresSink()],
  bufferSize: 100, // fewer, larger writes
  flushIntervalMs: 10_000
});
```

Raising `bufferSize` trades memory and worst-case loss for fewer round
trips: a crash loses whatever is still buffered, and a sink holds the whole
batch in memory while it writes.

`flushIntervalMs: null` is manual mode, covered below.

## Shutting instrumentation down

`instrument()` returns a handle:
`{ server, flush(): Promise<void>, close(): Promise<void> }`. In default
mode every `instrument()` call starts an interval timer and adds one
`beforeExit` listener. If your host disposes the server before the process
ends (tests, hot reload, one server per connection), call `close()` when
you dispose it. `close()` runs a final `flush()`, then clears the timer and
removes the listener. It is safe to call more than once. Manual mode
(`flushIntervalMs: null`, below) has no timer or listener to release, so
there `close()` behaves like `flush()`.

```ts
const handle = instrument(server, { serverName: 'my-server', sinks: [consoleSink()] });
// ...later, when the server is disposed:
await handle.close();
```

## Request-scoped runtimes (Cloudflare Workers)

On a long-lived Node process, ignore the handle - the interval timer and the
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
import { McpServer } from '@modelcontextprotocol/server';
import { instrument, d1Sink } from 'mcpsignals';

interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });
    const { flush } = instrument(server, {
      serverName: 'my-server',
      sinks: [d1Sink(env.DB)],
      flushIntervalMs: null // manual mode: no timer, no beforeExit listener
    });

    server.registerTool(/* ...as normal... */);

    // ...connect server to your transport, handle the request, and get a response...
    const response = await handleRequest(request, server);

    ctx.waitUntil(flush());
    return response;
  }
};
```

In manual mode, `instrument()` and `d1Sink` use no Node-only globals, so
they run on Workers without the `nodejs_compat` compatibility flag.
`consoleSink()` writes to `process.stdout`, which Workers doesn't provide,
so use `d1Sink` (or another sink) there.

### Known limitation: `client_name`/`client_version` will be null

This pattern - a fresh `McpServer` per request - has a consequence worth
knowing about up front: `client_name`/`client_version` on every `tool_call`
event will be `null`, for every caller, on every request.

The library reads client identity via `server.server.getClientVersion()`
(the low-level `Server` instance underneath `McpServer`, exposed via its
`.server` property), which only returns a value once that specific
`McpServer` instance has processed an `initialize` request and the SDK has
stored the client's `clientInfo` on it. But `initialize` and a later
`tools/call` are two separate HTTP
requests, each getting its own fresh `McpServer` per the pattern above - so
the instance handling `tools/call` never itself saw `initialize`, and
`getClientVersion()` has nothing to return. This isn't a Node-only or
Workers-only quirk of the SDK you can configure around; it falls directly
out of "construct the server fresh per request," which this section
recommends as the correct pattern regardless of the runtime.

If you need `client_name`/`client_version` populated in this shape, read
`clientInfo` off the raw JSON-RPC `initialize` request yourself, before it
ever reaches the SDK or `instrument()`, and persist it somewhere your
`tools/call` handler can read it back by whatever identity you already
have for the caller (an account id, an API key, a DID - whatever your auth
layer resolves). Then pass it through as a fallback wherever you build your
own event/row from the library's output, for every event where the
library-observed `client_name`/`client_version` is null. `instrument()`
itself has no option for this - there is no per-connection state on a
request-scoped runtime for it to hang the value off, so the SDK's own
capture mechanism is fundamentally unavailable here, not just failing to be
configured. Storage and fallback are entirely your application's concern,
independent of this library.

## Sinks

```ts
import { postgresSink, bigquerySink, otlpSink, d1Sink } from 'mcpsignals';
```

Each sink pulls credentials from its own client library's usual defaults
(env vars, Application Default Credentials, or the global OTel
TracerProvider) - there's no mcpsignals-specific config file.

### D1

`d1Sink(db, options?)` takes a `D1Database` binding directly - there's no
client library to load credentials from, since the binding is already
authenticated. Create the tables from `schema/events.md`'s D1 DDL first
(via `wrangler d1 migrations`, not by hand - see that file for why).

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { instrument, d1Sink } from 'mcpsignals';

interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });
    const { flush } = instrument(server, {
      serverName: 'my-server',
      sinks: [d1Sink(env.DB)],
      flushIntervalMs: null // manual mode - see "Request-scoped runtimes" above
    });

    server.registerTool(/* ...as normal... */);

    const response = await handleRequest(request, server);

    ctx.waitUntil(flush());
    return response;
  }
};
```

`d1Sink` handles the constraints that are easy to miss when hand-rolling a
D1 sink: `db.batch()` is a transaction (one bad row rolls back the whole
flush), so an oversized `arguments` payload is dropped rather than left in
the batch to fail it; and `ts` is written as Unix epoch milliseconds rather
than an ISO string, because SQLite's `datetime()` output doesn't compare
correctly against `toISOString()`'s. See the `d1Sink` doc comment
(`src/sinks/d1.ts`) and `schema/events.md`'s D1 section for the full
reasoning.
