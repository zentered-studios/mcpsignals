# Event schema

This is the contract both the Node.js and Python packages implement. If
you are adding a sink or reading raw rows out of a warehouse, this file is
the source of truth for field names, types, and semantics.

There is one event type, `tool_call`. Do not add a second without a
documented reason - every event type is a table both language packages have
to fill in identically forever.

A sink receives a batch of events. Each event carries an `event_type`
discriminator (`"tool_call"`) so a sink can route rows, and so a second
event type can be added later without changing the shape a sink already
handles. That field is the only thing added on top of the columns below; it
is not itself a column in the table's DDL, it is metadata the client library
attaches before handing events to a sink.

A `session_summary` event type was specified here through v2 but no release
ever emitted one, in either package. It was removed in v3 rather than left
as a table that stays empty forever. See the note at the end of this file.

## `tool_call`

One row per tool invocation.

| field | type | nullable | notes |
|---|---|---|---|
| `ts` | timestamp | no | UTC. When the call started, not when it finished. |
| `server_name` | string | no | The MCP server's advertised name. |
| `server_version` | string | yes | The MCP server's advertised version. |
| `tool_name` | string | no | Truncated to 128 chars when it comes from the `tools/call` request rather than the registration. |
| `session_id` | string | yes | Groups calls into one task. The transport's session where one exists: the `Mcp-Session-Id` of a stateful streamable HTTP connection (protocol revisions up to 2025-11-25). Revision 2026-07-28 removes protocol sessions, so on it `session_id` comes only from intent capture. Truncated to 128 chars. |
| `agent_id` | string | yes | Distinguishes parallel agents sharing a session. Only present if the host or intent-capture supplies one. Truncated to 128 chars when it comes from intent capture. |
| `client_name` | string | yes | The client's self-reported `clientInfo.name`: from the `initialize` handshake, or on revision 2026-07-28 from the request's `io.modelcontextprotocol/clientInfo` `_meta` key. The protocol does not verify it. Truncated to 128 chars. |
| `client_version` | string | yes | The client's self-reported `clientInfo.version`, from the same place as `client_name`. Truncated to 128 chars. |
| `user_id` | string | yes | The host application supplies this. The library never invents or infers it. |
| `org_id` | string | yes | Same as `user_id`: host-supplied only. |
| `duration_ms` | integer | no | Wall time from call start to response, including any handler-internal await. |
| `success` | boolean | no | Ground truth: what the client received. False for a result with `isError: true` and for a `tools/call` answered with a JSON-RPC error (unknown or disabled tool, or a request or result the SDK rejects). Nothing else is consulted. |
| `error_kind` | enum | yes | One of `not_found`, `empty`, `validation`, `auth_required`, `payment_required`, `internal`. Declared by the server or guessed from `error_message`; see "`error_kind` is declared by the server or guessed from the message" below. Null when `success` is true. |
| `error_message` | string | yes | Truncated to 2000 chars. Null when `success` is true. |
| `request_bytes` | integer | no | `byteLength` of the serialized `arguments` of the `tools/call` request as the client sent them, before injected intent-capture parameters are stripped. |
| `response_bytes` | integer | no | `byteLength` of the serialized tool result. 0 when the call was answered with a JSON-RPC error. |
| `arguments` | json | yes | The tool call's arguments. Null unless argument capture is explicitly enabled. Subject to redaction - see the redaction section of the top-level README. |
| `intent` | string | yes | The calling agent's stated reason for the call. Only present when intent capture is enabled for this tool. Truncated to 2000 chars. |
| `transport` | string | yes | `stdio` or `http`. Both packages default to `stdio` when there is no HTTP request context, so neither emits null today; the column stays nullable for future transports. |
| `protocol_version` | string | yes | The MCP protocol revision the call was served on, e.g. `2025-11-25` or `2026-07-28`: from the request's `io.modelcontextprotocol/protocolVersion` `_meta` key on 2026-07-28, otherwise the version negotiated in `initialize`. Truncated to 128 chars. |
| `request_id` | string | yes | The JSON-RPC request `id`, as a string. Unique per in-flight request on one connection, not globally. Truncated to 128 chars. |
| `trace_id` | string | yes | The 32-hex-char trace id of the W3C `traceparent` the client sent in the request `_meta`. Null when there was none or it was malformed. |
| `parent_span_id` | string | yes | The 16-hex-char span id from the same `traceparent`: the caller's span, which this call's span is a child of. |
| `result_type` | enum | yes | `complete` or `input_required`. `input_required` is a 2026-07-28 multi-round-trip round: the server asked the client for input and the client will call again. On a 2025-era connection the TypeScript SDK runs those rounds inside one call, which is recorded once with its final result. Null when the call was answered with a JSON-RPC error. |
| `error_code` | integer | yes | The JSON-RPC error code, when the call was answered with a JSON-RPC error rather than a result (e.g. `-32602` for an unknown tool in the TypeScript SDK). Null for every result, `isError` ones included. Python records null for an exception whose code depends on the transport. |
| `read_only_hint` | boolean | yes | The tool's `readOnlyHint` annotation. Null when the tool does not declare it; the spec default is false. Self-declared by the server, not verified. Python on a low-level `Server` reads both hints from the `tools/list` results it has answered, so they are null until a client lists the tools. |
| `destructive_hint` | boolean | yes | The tool's `destructiveHint` annotation. Null when the tool does not declare it; the spec default is true, meaningful only when `readOnlyHint` is false. |

### `error_kind` is declared by the server or guessed from the message

`error_kind` is a coarse bucket for dashboards and ad hoc queries. It is
**not** a replacement for `success`. A call with any `error_kind` is still a
failed call: `success` stays false.

The values:

- `not_found` - the requested resource does not exist.
- `empty` - the tool ran, but the result was empty in a way the handler
  treats as a failure.
- `validation` - the arguments failed validation.
- `auth_required` - the caller must sign in to use the tool.
- `payment_required` - the caller is signed in but needs a paid plan.
- `internal` - a real fault, or anything the heuristic cannot place.

#### Declared kinds

A server that already knows why a call failed records it directly:

- `instrument()` tool results: set `_meta["mcpsignals/error_kind"]` on the
  `isError` result, e.g. `"auth_required"`. Both packages export the key as
  `ERROR_KIND_META_KEY`. The key is ignored on a successful result. An
  unknown value falls back to the heuristic below. The client receives the
  result unchanged, `_meta` included.
- Events pushed to `EventBuffer` directly: set `error_kind` on the event.

Both packages export the valid values as `ERROR_KINDS` and the membership
check as `isErrorKind` / `is_error_kind`.

#### The heuristic

Without a declared kind, `error_kind` comes from pattern-matching the
free-text `error_message` (`classifyError` / `classify_error`). The
heuristic never produces `auth_required` or `payment_required`. Checks run
in this order:

1. `not_found` - the message matches a "no such resource" pattern.
2. `empty` - the message matches an "empty / no results" pattern.
3. `validation` - the message matches an argument/schema validation pattern.
4. `internal` - everything else. This is the default bucket, not a specific
   signal.

Known false-positive mode: a genuine internal failure whose message happens
to contain the words "not found" (e.g. `"config key 'timeout' not found in
environment"`) will bucket as `not_found` even though nothing the user asked
for was missing. An undeclared denial never buckets as `auth_required` or
`payment_required`: a message containing "required" (e.g. `"Payment
required."`, `"Login required."`) buckets as `validation`, and one that
matches no pattern (e.g. `"Sign in to use this tool."`) buckets as
`internal`. Declare the kind to avoid all three. Always treat `success` as the
authoritative pass/fail signal and `error_kind` as a filter on top of it,
never the reverse.

## Field naming conventions

- All field names are `snake_case` in every sink, regardless of the target
  language's own convention. A Python dict destined for a sink still uses
  `tool_name`, not `toolName`.
- Timestamps are always UTC and always sent as native timestamp types to
  sinks that have one (Postgres `timestamptz`, BigQuery `TIMESTAMP`,
  ClickHouse `DateTime64`), not epoch integers or ISO strings, except where
  the sink's wire format requires a string (OTLP) or the target has no
  native timestamp type (D1/SQLite - written as Unix epoch milliseconds,
  see the D1 section below for why).
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
  transport       text,
  protocol_version text,
  request_id      text,
  trace_id        text,
  parent_span_id  text,
  result_type     text,
  error_code      integer,
  read_only_hint  boolean,
  destructive_hint boolean
);

create index on mcpsignals_tool_call (ts);
create index on mcpsignals_tool_call (session_id);
create index on mcpsignals_tool_call (server_name, tool_name);
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
  transport       string,
  protocol_version string,
  request_id      string,
  trace_id        string,
  parent_span_id  string,
  result_type     string,
  error_code      int64,
  read_only_hint  bool,
  destructive_hint bool
)
partition by date(ts)
cluster by server_name, tool_name;
```

### D1 (SQLite)

```sql
create table mcpsignals_tool_call (
  ts              integer  not null,  -- Unix epoch milliseconds, not ISO text. See the d1Sink doc comment for why.
  server_name     text     not null,
  server_version  text,
  tool_name       text     not null,
  session_id      text,
  agent_id        text,
  client_name     text,
  client_version  text,
  user_id         text,
  org_id          text,
  duration_ms     integer  not null,
  success         integer  not null,  -- 0 or 1; SQLite has no boolean type
  error_kind      text,
  error_message   text,
  request_bytes   integer  not null,
  response_bytes  integer  not null,
  arguments       text,               -- JSON-encoded; null if absent or oversized, see d1Sink
  intent          text,
  transport       text,
  protocol_version text,
  request_id      text,
  trace_id        text,
  parent_span_id  text,
  result_type     text,
  error_code      integer,
  read_only_hint  integer,            -- 0, 1, or null when the tool does not declare it
  destructive_hint integer            -- 0, 1, or null when the tool does not declare it
);

create index idx_mcpsignals_tool_call_ts on mcpsignals_tool_call (ts);
create index idx_mcpsignals_tool_call_session_id on mcpsignals_tool_call (session_id);
create index idx_mcpsignals_tool_call_server_tool on mcpsignals_tool_call (server_name, tool_name);
```

Create these via `wrangler d1 migrations create <db-name> create_mcpsignals_tables`
(and `wrangler d1 migrations apply`) rather than a one-off script, so schema
changes stay migration-tracked the way D1 expects.

Query `ts` back out with `datetime(ts / 1000, 'unixepoch')` or a raw
millisecond comparison (`ts >= :cutoff_ms`), not `datetime('now', ...)`
compared directly against `ts` - `ts` is an integer, not SQLite's text
`datetime()` format, on purpose. An ISO string written via `toISOString()`
(`"2026-09-01T23:25:24.000Z"`) sorts incorrectly against `datetime()`'s
output (`"2026-09-01 23:25:24"`): `T` sorts above a space at the same byte
offset, so a `ts >= datetime('now', '-N days')` filter would silently
include the whole cutoff day.

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
  transport       Nullable(String),
  protocol_version LowCardinality(Nullable(String)),
  request_id      Nullable(String),
  trace_id        Nullable(String),
  parent_span_id  Nullable(String),
  result_type     LowCardinality(Nullable(String)),
  error_code      Nullable(Int32),
  read_only_hint  Nullable(Bool),
  destructive_hint Nullable(Bool)
)
engine = MergeTree
partition by toYYYYMM(ts)
order by (server_name, tool_name, ts);
```

ClickHouse has no native JSON column type available in every deployed
version (the experimental `JSON` type is not stable across all supported
server versions as of this writing), so `arguments` is stored as a
serialized JSON string. Query it with `JSONExtract*` functions or, on
ClickHouse versions where the `JSON` type is stable, swap the column type
and confirm before relying on it in production.

### Adding the protocol columns to an existing table

`protocol_version`, `request_id`, `trace_id`, `parent_span_id`,
`result_type`, `error_code`, `read_only_hint` and `destructive_hint` were
added after the tables above were first published. Every column is
nullable, but the Postgres, BigQuery and D1 sinks insert them by name, so
run these before deploying the release that writes them. Otherwise inserts
fail and EventBuffer drops those batches.

```sql
-- Postgres
alter table mcpsignals_tool_call
  add column protocol_version text,
  add column request_id       text,
  add column trace_id         text,
  add column parent_span_id   text,
  add column result_type      text,
  add column error_code       integer,
  add column read_only_hint   boolean,
  add column destructive_hint boolean;

-- BigQuery
alter table `mcpsignals.tool_call`
  add column protocol_version string,
  add column request_id       string,
  add column trace_id         string,
  add column parent_span_id   string,
  add column result_type      string,
  add column error_code       int64,
  add column read_only_hint   bool,
  add column destructive_hint bool;

-- D1 (SQLite takes one column per statement)
alter table mcpsignals_tool_call add column protocol_version text;
alter table mcpsignals_tool_call add column request_id text;
alter table mcpsignals_tool_call add column trace_id text;
alter table mcpsignals_tool_call add column parent_span_id text;
alter table mcpsignals_tool_call add column result_type text;
alter table mcpsignals_tool_call add column error_code integer;
alter table mcpsignals_tool_call add column read_only_hint integer;
alter table mcpsignals_tool_call add column destructive_hint integer;

-- ClickHouse
alter table mcpsignals_tool_call
  add column protocol_version LowCardinality(Nullable(String)),
  add column request_id       Nullable(String),
  add column trace_id         Nullable(String),
  add column parent_span_id   Nullable(String),
  add column result_type      LowCardinality(Nullable(String)),
  add column error_code       Nullable(Int32),
  add column read_only_hint   Nullable(Bool),
  add column destructive_hint Nullable(Bool);
```

For D1, put the statements in a new migration (`wrangler d1 migrations
create <db-name> add_mcpsignals_protocol_columns`) rather than running them
by hand.

## OTLP mapping

The `otlp` sink emits `tool_call` as a span rather than a warehouse row. It
does not get its own DDL here because it isn't tabular. See the OTLP sink
implementation for the field-by-field mapping to OpenTelemetry GenAI
semantic-convention attribute names - that mapping is verified against the
live spec at implementation time (this schema predates that verification and
must not be treated as the source of truth for OTel attribute names).

A span is a root span unless the event has `trace_id` and `parent_span_id`.
Then it is a child of the caller's span, so a client that propagates
`traceparent` sees the tool call inside its own trace.

## The `session_summary` event type, removed in v3

Through v2 this file specified a second event type, `session_summary`, as
"emitted once per session, on session end", with `CREATE TABLE` DDL for
every warehouse. No release ever emitted one. Both packages only ever
constructed `tool_call` events; the type, the sink routing and the DDL all
existed, and nothing filled them. Anyone who followed the DDL here built a
`mcpsignals_session_summary` table, with a unique index on `session_id`,
that stayed empty for the life of their deployment.

v3 removes it rather than leave a promise the library does not keep. What
that means for you:

- **You never queried the table.** Drop it whenever convenient. Nothing
  read or wrote it. `drop table mcpsignals_session_summary;`
- **You imported the type.** `SessionSummaryEvent` is gone from both
  packages' public exports. Nothing could construct one with real data, so
  any code referencing it was either dead or building the event itself.
- **You wrote your own sink.** Sinks take `AnyEvent[]` (Node) or
  `list[ToolCallEvent]` (Python), which is now one event type rather than a
  union. A sink that already branched on `event_type` keeps working, and
  that branch is still the right shape to keep: it is the seam a future
  second event type would widen.
- **You set `sessionSummaryTable`** on `postgresSink`, `bigquerySink` or
  `d1Sink`. That option is gone. Remove it.

The per-session numbers the type described - `call_count`,
`distinct_tools_used`, `wall_duration_ms`, `error_count` - are all derivable
from the `tool_call` rows you already have:

```sql
select
  session_id,
  count(*)                                         as call_count,
  count(distinct tool_name)                        as distinct_tools_used,
  extract(epoch from (max(ts) - min(ts))) * 1000   as wall_duration_ms,
  count(*) filter (where not success)              as error_count
from mcpsignals_tool_call
where session_id is not null
group by session_id;
```

That query is what the event type would have precomputed. Running it on
demand costs a scan and cannot disagree with the underlying rows.
