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

Every tool call now writes a row - timestamp, tool name, duration,
success/failure, byte sizes - to wherever `sinks` points. See
[Sinks](#sinks) to send those rows to Postgres, BigQuery, or your
OpenTelemetry collector instead.

## Compatibility

|  | Node.js | Python |
|---|---|---|
| Install | `npm install mcpsignals` | `pip install mcpsignals` |
| Runtime | Node.js 20+ | Python 3.10+ |
| MCP SDK | `@modelcontextprotocol/server` v2 (peer dep, with `zod` v4) | `mcp` v2 |
| Instruments | `McpServer` | `MCPServer` and the low-level `Server` |

Both packages write the same event contract, so a Node.js server and a
Python server can share tables.

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
  types only**. `{"query": "jane@example.com"}` is recorded as
  `{"query": "<string>"}`.
- To record real values, explicitly allowlist which keys are safe
  (`redaction.allow`). `redaction.deny` forces a key back to type-only even
  if `allow` also lists it.
- A custom `redaction.redactor` function replaces that logic entirely and is
  solely responsible for what gets recorded; `allow`/`deny` do not apply to
  it.

## Sinks

| Sink | Node.js | Python | Extra dependency |
|---|---|---|---|
| console | `consoleSink()` | `ConsoleSink()` | none |
| Postgres | `postgresSink()` | `PostgresSink()` | `pg` v8 / `mcpsignals[postgres]` |
| BigQuery | `bigquerySink()` | `BigQuerySink()` | `@google-cloud/bigquery` v7 / `mcpsignals[bigquery]` |
| OTLP | `otlpSink()` | `OtlpSink()` | `@opentelemetry/api` v1 / `mcpsignals[otlp]` |

Node.js imports these from `mcpsignals`, Python from `mcpsignals.sinks`;
install only the dependency for the sink you use. `console` writes JSON
lines to stdout and is what Python uses when you pass no `sinks` at all.
Postgres and BigQuery write the tables in
[`schema/events.md`](schema/events.md). OTLP emits one span per tool call
using whatever `TracerProvider` your app already configured (standard OTel
zero-code pattern - this sink does not manage its own exporter).

Credentials come from each sink's own SDK defaults and environment
(`PGHOST`, Application Default Credentials, `OTEL_EXPORTER_OTLP_ENDPOINT`),
so there's no config file format to learn:
[`docs/environment-variables.md`](docs/environment-variables.md),
[`docs/bigquery.md`](docs/bigquery.md).

Events are buffered in memory and flushed on a size threshold or an
interval, whichever comes first, plus a best-effort flush on shutdown. A
sink that throws is caught, logged once, and otherwise ignored: a failing
warehouse write never breaks a tool call and never delays a tool response.

That interval/shutdown-flush pattern assumes a long-lived process. On a
request-scoped, isolate-based runtime like Cloudflare Workers, neither is
reliable - see the Node.js package README's
["Request-scoped runtimes"](packages/node/README.md#request-scoped-runtimes-cloudflare-workers)
section for the manual-flush pattern (`flushIntervalMs: null` plus
`ctx.waitUntil(flush())`).

## Intent capture

Optional, off by default. When enabled, the library adds `session_id`,
`agent_id`, and an `intent` field ("why are you calling this tool") to the
schemas your server advertises, then strips all three back out before your
handler sees them - it receives exactly what it would have without this
library, and both packages have tests proving it.

It costs tokens on every tool schema, and models sometimes ignore the field
or invent a plausible-sounding reason. Turn it on only if "why did the agent
call this" is a question you need answered.

All three values are caller-controlled, so the library bounds them before
they reach any sink: `intent` is truncated to 2000 chars (the same cap as
`error_message`), `session_id` and `agent_id` to 128. A non-string value is
recorded as null. This holds for every sink, including your own - an
oversized value can't fail a batched write and take an entire flush of
unrelated events with it.

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
