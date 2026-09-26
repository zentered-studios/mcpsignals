<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="mcpsignals" width="72" height="72">
  </picture>
</p>

# mcpsignals

You put an MCP server in front of your API so agents could use it.
`mcpsignals` is Google Analytics for those tools: see which ones your
team's agents actually reach for, which are slow or failing, and which are
quietly burning tokens and cost by returning far more output than anyone
asked for. All of it lands in a database you already run, not a vendor's
dashboard.

- **Drop-in, not a rewrite.** Wrap your existing server in one call; nothing
  about how you register tools changes.
- **Nothing leaves your infrastructure.** The library only ever talks to the
  sink you configure. No network call at import time, ever - not even an
  anonymous ping.
- **Redacted by default.** Tool arguments aren't recorded unless you opt in,
  and even then only key names and value types.

## Quick start

**Node.js**

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { instrument, consoleSink } from 'mcpsignals';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

instrument(server, {
  serverName: 'my-server',
  serverVersion: '1.0.0',
  sinks: [consoleSink()]
});

server.registerTool('search', { /* ... */ }, async args => { /* ... */ });
```

On a stdio transport, pass `consoleSink({ stream: process.stderr })`. stdout
is the MCP wire there, and `StdioServerTransport` writes to the same
`process.stdout` the default sink uses. See [Sinks](#sinks).

**Python**

```python
from mcp.server.mcpserver import MCPServer
from mcpsignals import instrument

server = MCPServer("my-server")

# With no `sinks=`, Python defaults to the console sink.
instrument(server, server_name="my-server", server_version="1.0.0")


@server.tool()
def search(query: str) -> str:
    """Search something."""
    ...
```

**Go**

Use the official Go SDK with `mcpsignals.Instrument(server, options)`; no tool
handler changes are needed. See the [installation and usage guide](packages/go/README.md)
and [runnable stdio example](packages/go/examples/stdio/main.go). The Go module
currently includes console/custom sinks; warehouse sinks and intent capture are
deferred. The first Go release has not yet been published.

Every tool call now writes a row - timestamp, tool name, duration,
success/failure, byte sizes - to wherever `sinks` points. See
[Sinks](#sinks) to send those rows to Postgres, BigQuery, or your
OpenTelemetry collector instead.

## Compatibility

|  | Node.js | Python | Go |
|---|---|---|---|
| Install | `npm install mcpsignals` | `pip install mcpsignals` | [Go installation](packages/go/README.md#install) (not yet released) |
| Runtime | Node.js 20+ | Python 3.10+ | Go 1.25.0+ |
| MCP SDK | `@modelcontextprotocol/server` v2 (peer dep, with `zod` v4) | `mcp` v2 | Official `go-sdk/mcp` v1.8.0 |
| Instruments | `McpServer` | `MCPServer` and the low-level `Server` | `*mcp.Server` receiving middleware |
| Built-in sinks | Console, Postgres, BigQuery, OTLP, D1 | Console, Postgres, BigQuery, OTLP | Console (stderr by default); custom sink interface |
| Intent capture | Yes | Yes | Deferred |

All three packages write the same event contract, so their servers can share
warehouse tables and queries on `__type` (see
[Argument capture](#argument-capture-is-opt-in-and-redacted-by-default)).
The sink, intent-capture, and lifecycle examples below target Node/Python; see the
[Go guide](packages/go/README.md) for Go options and feature differences.

## Why this exists instead of a hosted analytics product

AgentCat, PostHog's MCP analytics, and Sentry all do a version of this by
shipping your agent traffic to their cloud and charging per session, and
they'll get you a dashboard faster than we will. Use this instead when your
tool arguments cannot go to a third party.

| | mcpsignals | AgentCat / PostHog / Sentry |
|---|---|---|
| Where data lives | your own Postgres/BigQuery/ClickHouse/OTLP collector | their cloud |
| Pricing | free, it's a library | per-session or per-event |
| Dashboard | none - bring your own BI tool | included |
| Account/API key | none | required |

## Argument capture is opt-in, and redacted by default

Tool arguments are whatever the caller typed - personal data and secrets
included. That's why capture defaults off, and why turning it on doesn't
mean "record everything":

- Capture (`captureArguments` / `capture_arguments`) is **off by default**:
  the `arguments` field is always null and no argument reaches a sink.
- Turned on with no further configuration, you get **argument keys and value
  types only**. Each value becomes a `{"__type": ...}` marker. All three packages
  use the same JSON type names (`string`, `number`, `boolean`, `object`,
  `array`, `null`), so `{"query": "jane@example.com", "limit": 10}` is
  recorded as `{"query": {"__type": "string"}, "limit": {"__type": "number"}}`
  by any of them.
- To record real values, explicitly allowlist which keys are safe
  (`redaction.allow`). `redaction.deny` forces a key back to type-only even
  if `allow` also lists it.
- A custom `redaction.redactor` function replaces that logic entirely and is
  solely responsible for what gets recorded; `allow`/`deny` do not apply to
  it. If it throws, the event is recorded with `arguments` null, never with
  the raw arguments, and the tool result is unaffected.

## Sinks

| Sink | Node.js | Python | Extra dependency |
|---|---|---|---|
| console | `consoleSink()` | `ConsoleSink()` | none |
| Postgres | `postgresSink()` | `PostgresSink()` | `pg` v8 / `mcpsignals[postgres]` |
| BigQuery | `bigquerySink()` | `BigQuerySink()` | `@google-cloud/bigquery` v7 / `mcpsignals[bigquery]` |
| D1 | `d1Sink()` | - | none (takes a `D1Database` binding directly) |
| OTLP | `otlpSink()` | `OtlpSink()` | `@opentelemetry/api` v1 / `mcpsignals[otlp]` |

Node.js imports these from `mcpsignals`, Python from `mcpsignals.sinks`;
install only the dependency for the sink you use. `console` writes JSON
lines to stdout by default and is what Python uses when you pass no `sinks`
at all. On a stdio transport it must write to stderr instead. The
[MCP spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio)
says: "The server MUST NOT write anything to its `stdout` that is not a valid
MCP message" and "The server MAY write UTF-8 strings to its standard error
(`stderr`) for logging purposes." Pass the stream explicitly:

```ts
sinks: [consoleSink({ stream: process.stderr })]
```

```python
import sys
from mcpsignals.sinks import ConsoleSink

instrument(server, server_name="my-server", sinks=[ConsoleSink(stream=sys.stderr)])
```

The default stays stdout so HTTP servers and log collectors that read
stdout keep working unchanged.

Postgres, BigQuery, and D1 write the tables in
[`schema/events.md`](schema/events.md). OTLP emits one span per tool call
using whatever `TracerProvider` your app already configured (standard OTel
zero-code pattern - this sink does not manage its own exporter). D1 is
Node-only: the Python package has no Cloudflare Workers story, and D1 is
only reachable from a Worker.

Credentials come from each sink's own SDK defaults and environment
(`PGHOST`, Application Default Credentials, `OTEL_EXPORTER_OTLP_ENDPOINT`),
so there's no config file format to learn:
[`docs/environment-variables.md`](docs/environment-variables.md),
[`docs/bigquery.md`](docs/bigquery.md). D1 takes its `D1Database` binding
directly instead, since the binding is already authenticated - see the
Node.js package README's [D1 section](packages/node/README.md#d1).

Events are buffered in memory and flushed on a size threshold or an
interval, whichever comes first, plus a best-effort flush on shutdown. A
sink that throws is caught, logged once, and otherwise ignored: a failing
warehouse write never breaks a tool call and never delays a tool response.
The same holds for every other library-side step around a call (byte
counting, `resolveIdentity` / `resolve_identity`, redaction, event
construction): a failure there is logged once, the step falls back to a
neutral value, and the handler's own result or exception reaches the client
unchanged.

That interval/shutdown-flush pattern assumes a long-lived process. On a
request-scoped, isolate-based runtime like Cloudflare Workers, neither is
reliable - see the Node.js package README's
["Request-scoped runtimes"](packages/node/README.md#request-scoped-runtimes-cloudflare-workers)
section for the manual-flush pattern (`flushIntervalMs: null` plus
`ctx.waitUntil(flush())`). Python has the same manual mode
(`flush_interval_s=None` plus `await handle_for(server).flush()`): see the
Python package README's
["Request-scoped runtimes and manual flushing"](packages/python/README.md#request-scoped-runtimes-and-manual-flushing)
section.

## Intent capture

Optional, off by default. When enabled, the library adds `session_id`,
`agent_id`, and an `intent` field ("why are you calling this tool") to the
schemas your server advertises, then strips all three back out before your
handler sees them - it receives exactly what it would have without this
library, and the Node and Python packages have tests proving it. The Go
package does not support intent capture yet.

Node takes `intentCapture`. `true` enables it for every tool. The object
form enables only the tools named with `true`; every unlisted tool stays
off.

```ts
instrument(server, { intentCapture: true });
instrument(server, { intentCapture: { tools: { search: true } } });
```

Python takes `intent_capture` as the global default and
`intent_capture_tools` as per-tool overrides layered on top of it.

```python
instrument(server, intent_capture=True, intent_capture_tools={"search": False})
```

The shapes differ: Python can express global-on with per-tool off, Node
cannot.

It costs tokens on every tool schema, and models sometimes ignore the field
or invent a plausible-sounding reason. Turn it on only if "why did the agent
call this" is a question you need answered.

A tool that declares its own `session_id`, `agent_id`, or `intent`
parameter loses it when intent capture is on for that tool. Node and Python
strip those three keys from the arguments before the handler runs. In Node
the handler never sees the value, and the library's field definition
replaces the tool's own in the advertised schema. In Python a required
parameter with one of those names fails argument validation, and an
optional one silently falls back to its default while the event carries the
caller's value. Rename the tool parameter, or do not enable intent capture
for that tool.

All three values are caller-controlled, so the library bounds them before
they reach any sink: `intent` is truncated to 2000 chars (the same cap as
`error_message`), `session_id` and `agent_id` to 128. A non-string value is
recorded as null. This holds for every sink, including your own - an
oversized value can't fail a batched write and take an entire flush of
unrelated events with it. `client_name` and `client_version`, which the
client declares in its `initialize` handshake, take the same 128-char cap,
as does `tool_name` where it is read off the request (Python).

## Identity: `user_id` and `org_id`

Two columns in the event schema are never filled in by the library:
`user_id` and `org_id`. It has no way to know who a caller is, and it does
not guess. You supply them with a resolver, which is the only thing that
ever sets them.

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

```python
def resolve_identity(ctx):
    account = look_up_account(ctx)  # your auth layer, not ours
    return (account.id, account.org_id) if account else (None, None)


instrument(server, server_name="my-server", resolve_identity=resolve_identity)
```

The shapes differ. Node receives `{ sessionId }` and returns
`{ userId, orgId }` (or nothing). Python receives the middleware's raw
request context and returns a `(user_id, org_id)` tuple. Both may be sync or
async.

Three things hold in all three packages, except that Go's `ResolveIdentity`
does not log failures; see the [Go guide](packages/go/README.md#privacy).

- **It runs after your handler**, so a slow resolver never lands in
  `duration_ms`. `duration_ms` is wall time from call start to response, per
  [`schema/events.md`](schema/events.md), and the resolver is outside that
  window.
- **A resolver that throws costs you the identity, nothing else.** The
  failure is logged once, the event is still recorded with a null
  `user_id`/`org_id`, and the tool result reaches the client untouched.
- **Returning nothing is fine.** Anonymous calls record null, which is what
  the column means.

One caveat on the Node side. The resolver receives the session id from the
transport context only. When intent capture is on and the calling agent
supplies a `session_id` itself, the event records that value but the
resolver still sees `undefined` for it, so the two can disagree on a stdio
transport. Do not key identity off the resolver's `sessionId` alone if you
rely on intent-capture session ids.

## Buffering and flush timing

Events are batched in memory, not written one per call. Node and Python take
the same two knobs. Go has the same defaults, but its manual mode disables the
size trigger too. Go has no shutdown hook: call `Close` on the handle before
exit, or buffered events are lost. See the
[Go guide](packages/go/README.md#lifecycle-and-delivery).

| | Node.js | Python | Default |
|---|---|---|---|
| Flush after N events | `bufferSize` | `buffer_size` | 20 |
| Flush every N | `flushIntervalMs` | `flush_interval_s` | 5000 ms / 5.0 s |

Whichever comes first wins, plus a best-effort flush on shutdown in Node and
Python. Passing
`null` / `None` as the interval switches to manual mode, which drops both
the timer and the shutdown hook and leaves every flush to you. That is the
right setting on request-scoped runtimes, covered in the
[Node.js](packages/node/README.md#request-scoped-runtimes-cloudflare-workers)
and [Python](packages/python/README.md#request-scoped-runtimes-and-manual-flushing)
package READMEs.

Raising `bufferSize` trades memory and worst-case loss for fewer round
trips: a crash loses whatever is still buffered, so a larger buffer loses
more, and a sink holds the whole batch in memory while it writes.

## What this is not

- Not a dashboard or a chart. Point your own BI tool at the warehouse.
- Not an auth or multi-tenancy layer. `user_id`/`org_id` are whatever your
  host application tells us; we never infer them.
- Not a query or aggregation layer over the warehouse you write to.

## Reference

- [`packages/node`](packages/node) - Node.js package, `mcpsignals` on npm
  (TypeScript/ESM).
- [`packages/python`](packages/python) - Python package, `mcpsignals` on
  PyPI (async-first).
- [`schema/events.md`](schema/events.md) - the shared event contract, with
  copy-pasteable `CREATE TABLE` DDL for Postgres, BigQuery, and ClickHouse.
- [`examples/`](examples) - four runnable one-file examples: Express and
  Fastify (Node.js), FastAPI and Starlette (Python).

## Support

`mcpsignals` is built and maintained by [Zentered Studios](https://github.com/zentered-studios).
The library itself is free and always will be - if you want help wiring it
into an existing MCP server, a sink for a warehouse that isn't listed here,
or ongoing support on a production deployment, reach out at
patrick@zentered-studios.com.

## License

MIT. See [LICENSE](LICENSE).
