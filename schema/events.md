# Event schema

This is the contract both the Node.js and Python packages implement. If
you are adding a sink or reading raw rows out of a warehouse, this file is
the source of truth for field names, types, and semantics.

There are two event types. Do not add a third without a documented reason -
every event type is a table both language packages have to fill in
identically forever.

A sink receives a batch of events of either type. Each event carries an
`event_type` discriminator (`"tool_call"` or `"session_summary"`) so a sink
can route rows to the right table. That field is the only thing added on
top of the columns below; it is not itself a column in either table's DDL,
it is metadata the client library attaches before handing events to a sink.

## `tool_call`

One row per tool invocation.

| field | type | nullable | notes |
|---|---|---|---|
| `ts` | timestamp | no | UTC. When the call started, not when it finished. |
| `server_name` | string | no | The MCP server's advertised name. |
| `server_version` | string | yes | The MCP server's advertised version. |
| `tool_name` | string | no | |
| `session_id` | string | yes | Groups calls into one task. Only present where the transport exposes a session concept. Truncated to 128 chars when it comes from intent capture. |
| `agent_id` | string | yes | Distinguishes parallel agents sharing a session. Only present if the host or intent-capture supplies one. Truncated to 128 chars when it comes from intent capture. |
| `client_name` | string | yes | From the MCP `initialize` handshake. |
| `client_version` | string | yes | From the MCP `initialize` handshake. |
| `user_id` | string | yes | The host application supplies this. The library never invents or infers it. |
| `org_id` | string | yes | Same as `user_id`: host-supplied only. |
| `duration_ms` | integer | no | Wall time from call start to response, including any handler-internal await. |
| `success` | boolean | no | Ground truth. Derived directly from the tool result's `isError` flag, nothing else. |
| `error_kind` | enum | yes | One of `not_found`, `empty`, `validation`, `internal`. See "error_kind is a heuristic" below. Null when `success` is true. |
| `error_message` | string | yes | Truncated to 2000 chars. Null when `success` is true. |
| `request_bytes` | integer | no | `byteLength` of the serialized tool arguments as sent to the handler, before injected intent-capture parameters are stripped. |
| `response_bytes` | integer | no | `byteLength` of the serialized tool result. |
| `arguments` | json | yes | The tool call's arguments. Null unless argument capture is explicitly enabled. Subject to redaction - see the redaction section of the top-level README. |
| `intent` | string | yes | The calling agent's stated reason for the call. Only present when intent capture is enabled for this tool. Truncated to 2000 chars. |
| `transport` | string | yes | `stdio`, `http`, or whatever the SDK reports. Null if the SDK does not expose it. |

### `error_kind` is a heuristic, not a structured code

`error_kind` is produced by pattern-matching the free-text `error_message`
into one of four buckets. It exists so dashboards and ad hoc queries have
something coarse to filter or group by. It is **not** ground truth and it is
**not** a replacement for `success`.

Known false-positive mode: a genuine internal failure whose message happens
to contain the words "not found" (e.g. `"config key 'timeout' not found in
environment"`) will bucket as `not_found` even though nothing the user asked
for was missing. Always treat `success` as the authoritative pass/fail
signal and `error_kind` as a rough filter on top of it, never the reverse.

The four buckets, in the order they are checked:

1. `not_found` - the message matches a "no such resource" pattern.
2. `empty` - the tool ran successfully in the sense of not throwing, but
   `isError` was still set because the result was empty/zero-length in a way
   the handler considered a failure.
3. `validation` - the message matches an argument/schema validation pattern.
4. `internal` - everything else. This is the default bucket, not a specific
   signal.

## `session_summary`

Emitted once per session, on session end, where the transport exposes a
detectable end-of-session point (long-lived `stdio` and stateful `http`
sessions; not stateless per-request `http`).

| field | type | nullable | notes |
|---|---|---|---|
| `ts` | timestamp | no | UTC. When the session was detected as ended. |
| `session_id` | string | no | |
| `server_name` | string | no | |
| `server_version` | string | yes | |
| `user_id` | string | yes | Host-supplied only, same rule as `tool_call.user_id`. |
| `org_id` | string | yes | Host-supplied only. |
| `call_count` | integer | no | Total `tool_call` events emitted for this `session_id`. |
| `distinct_tools_used` | integer | no | Count of distinct `tool_name` values across this session's calls. |
| `wall_duration_ms` | integer | no | Time from first call's `ts` to session end detection. |
| `error_count` | integer | no | Count of this session's `tool_call` events where `success` is false. |

## Field naming conventions

- All field names are `snake_case` in every sink, regardless of the target
  language's own convention. A Python dict destined for a sink still uses
  `tool_name`, not `toolName`.
- Timestamps are always UTC and always sent as native timestamp types to
  sinks that have one (Postgres `timestamptz`, BigQuery `TIMESTAMP`,
  ClickHouse `DateTime64`), not epoch integers or ISO strings, except where
  the sink's wire format requires a string (OTLP).
- `null` means "not applicable or not available," never `"unknown"` as a
  string sentinel and never an empty string.

## SQL DDL

Copy-pasteable table definitions for each supported warehouse sink. These
are what the built-in `postgres` and `bigquery` sinks assume exist; they do
not create tables for you.

### Postgres

```sql
create table mcpsignals_tool_call (
  ts              timestamptz     not null,
  server_name     text            not null,
  server_version  text,
  tool_name       text            not null,
  session_id      text,
  agent_id        text,
  client_name     text,
  client_version  text,
  user_id         text,
  org_id          text,
  duration_ms     integer         not null,
  success         boolean         not null,
  error_kind      text,
  error_message   text,
  request_bytes   integer         not null,
  response_bytes  integer         not null,
  arguments       jsonb,
  intent          text,
  transport       text
);

create index on mcpsignals_tool_call (ts);
create index on mcpsignals_tool_call (session_id);
create index on mcpsignals_tool_call (server_name, tool_name);

create table mcpsignals_session_summary (
  ts                    timestamptz  not null,
  session_id            text         not null,
  server_name           text         not null,
  server_version        text,
  user_id               text,
  org_id                text,
  call_count            integer      not null,
  distinct_tools_used   integer      not null,
  wall_duration_ms      integer      not null,
  error_count           integer      not null
);

create index on mcpsignals_session_summary (ts);
create unique index on mcpsignals_session_summary (session_id);
```

### BigQuery

```sql
create table if not exists `mcpsignals.tool_call` (
  ts              timestamp    not null,
  server_name     string       not null,
  server_version  string,
  tool_name       string       not null,
  session_id      string,
  agent_id        string,
  client_name     string,
  client_version  string,
  user_id         string,
  org_id          string,
  duration_ms     int64        not null,
  success         bool         not null,
  error_kind      string,
  error_message   string,
  request_bytes   int64        not null,
  response_bytes  int64        not null,
  arguments       json,
  intent          string,
  transport       string
)
partition by date(ts)
cluster by server_name, tool_name;

create table if not exists `mcpsignals.session_summary` (
  ts                    timestamp   not null,
  session_id            string      not null,
  server_name           string      not null,
  server_version        string,
  user_id               string,
  org_id                string,
  call_count            int64       not null,
  distinct_tools_used   int64       not null,
  wall_duration_ms      int64       not null,
  error_count           int64       not null
)
partition by date(ts)
cluster by server_name;
```

### ClickHouse

```sql
create table mcpsignals_tool_call (
  ts              DateTime64(3),
  server_name     LowCardinality(String),
  server_version  Nullable(String),
  tool_name       LowCardinality(String),
  session_id      Nullable(String),
  agent_id        Nullable(String),
  client_name     Nullable(String),
  client_version  Nullable(String),
  user_id         Nullable(String),
  org_id          Nullable(String),
  duration_ms     UInt32,
  success         Bool,
  error_kind      Nullable(String),
  error_message   Nullable(String),
  request_bytes   UInt32,
  response_bytes  UInt32,
  arguments       Nullable(String),
  intent          Nullable(String),
  transport       Nullable(String)
)
engine = MergeTree
partition by toYYYYMM(ts)
order by (server_name, tool_name, ts);

create table mcpsignals_session_summary (
  ts                    DateTime64(3),
  session_id            String,
  server_name           LowCardinality(String),
  server_version        Nullable(String),
  user_id               Nullable(String),
  org_id                Nullable(String),
  call_count            UInt32,
  distinct_tools_used   UInt32,
  wall_duration_ms      UInt32,
  error_count           UInt32
)
engine = MergeTree
partition by toYYYYMM(ts)
order by (server_name, session_id);
```

ClickHouse has no native JSON column type available in every deployed
version (the experimental `JSON` type is not stable across all supported
server versions as of this writing), so `arguments` is stored as a
serialized JSON string. Query it with `JSONExtract*` functions or, on
ClickHouse versions where the `JSON` type is stable, swap the column type
and confirm before relying on it in production.

## OTLP mapping

The `otlp` sink emits `tool_call` as a span (or a log record, for hosts that
only want logs) rather than a warehouse row. It does not get its own DDL
here because it isn't tabular. See the OTLP sink implementation for the
field-by-field mapping to OpenTelemetry GenAI semantic-convention attribute
names - that mapping is verified against the live spec at implementation
time (this schema predates that verification and must not be treated as the
source of truth for OTel attribute names).
