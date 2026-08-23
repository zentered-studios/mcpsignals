# Environment variables and setup

`mcpsignals` has no config file and no `mcpsignals`-specific environment
variables of its own. Every sink authenticates exactly the way its
underlying client library always does - this page collects those variables
in one place so you don't have to go find each library's own docs.

If you're only using the `console` sink (the default), there's nothing to
configure - skip this page.

## Postgres

The `postgres` sink (`pg` in Node.js, `asyncpg` in Python) resolves connection
info the same way both libraries always have: standard `libpq`-style
environment variables, read when you don't pass a `connectionString`/`dsn`
or an existing pool.

| Variable | Meaning | Default |
|---|---|---|
| `PGHOST` | Server host | `localhost` |
| `PGPORT` | Server port | `5432` |
| `PGUSER` | Username | current OS user |
| `PGPASSWORD` | Password | (none) |
| `PGDATABASE` | Database name | same as `PGUSER` |
| `PGSSLMODE` | SSL mode | driver default (usually `prefer`) |

Verified directly against the installed `asyncpg` source (`connect_utils.py`)
and matches `pg`'s (Node.js) documented behavior - both fall back to these
exact names.

```ts
import { postgresSink } from 'mcpsignals';

postgresSink(); // PGHOST/PGUSER/etc. from the environment
postgresSink({ connectionString: 'postgresql://user:pass@host:5432/db' });
```

```python
from mcpsignals.sinks import PostgresSink

PostgresSink()  # PGHOST/PGUSER/etc. from the environment
PostgresSink(dsn="postgresql://user:pass@host:5432/db")
```

Table setup (both languages, same DDL): see
[`schema/events.md`](../schema/events.md#postgres).

## BigQuery

Covered on its own page: [`docs/bigquery.md`](bigquery.md). Short version:
`GOOGLE_APPLICATION_CREDENTIALS` (or ambient credentials on GCP) plus
`GOOGLE_CLOUD_PROJECT` if the project isn't otherwise inferable - standard
Application Default Credentials, nothing `mcpsignals`-specific.

## OTLP

**The `otlp` sink does not export anything by itself.** It calls
`trace.getTracer('mcpsignals')` (Node.js: `@opentelemetry/api`; Python:
`opentelemetry-api`) and emits spans against whatever `TracerProvider` is
already registered globally in your process. If nothing has registered one,
the OpenTelemetry API's default is a no-op tracer - the sink runs without
error, and every span silently goes nowhere. `mcpsignals` peer-depends on
the API package only, never an SDK or exporter, so it never picks a wire
protocol or collector endpoint on your behalf - setting an env var alone
does not turn this sink on.

To actually export spans, your **host application** - not `mcpsignals` -
needs to install and configure an OpenTelemetry SDK. The common path is the
"zero-code" / auto-instrumentation launcher, which reads these standard
OTel env vars:

| Variable | Meaning |
|---|---|
| `OTEL_SERVICE_NAME` | Service name attached to every span |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector endpoint, e.g. `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc`, `http/protobuf`, or `http/json` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Extra headers (auth tokens, etc.), `key=value,key2=value2` |
| `OTEL_TRACES_EXPORTER` | Usually `otlp` |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes, same `key=value` format |

Node.js, minimal setup alongside your server:

```sh
npm install --save-dev @opentelemetry/auto-instrumentations-node
OTEL_SERVICE_NAME=my-server OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  node --require @opentelemetry/auto-instrumentations-node/register server.js
```

Python:

```sh
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install
OTEL_SERVICE_NAME=my-server OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  opentelemetry-instrument python server.py
```

Once a real `TracerProvider` is registered this way, `otlpSink()`/`OtlpSink()`
starts producing real spans - no `mcpsignals`-side change needed. See
[`schema/events.md`](../schema/events.md#otlp-mapping) for the exact
attribute mapping and which OTel semantic-convention attributes are Stable
versus Development.
