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

## Sinks

```ts
import { postgresSink, bigquerySink, otlpSink } from 'mcpsignals';
```

Each sink pulls credentials from its own client library's usual defaults
(env vars, Application Default Credentials, or the global OTel
TracerProvider) - there's no mcpsignals-specific config file.
