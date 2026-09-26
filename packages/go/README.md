# mcpsignals for Go

Drop-in tool-call analytics for the official
[`github.com/modelcontextprotocol/go-sdk/mcp`](https://github.com/modelcontextprotocol/go-sdk)
SDK. Events go only to the sinks you configure. No hosted service, inferred
identity, or network calls at initialization.

## Install

Requires **Go 1.25.0+**. Built and tested against **Go SDK v1.8.0**; other SDK
versions are not yet verified. CI covers Go 1.25, 1.26, and 1.27.

This module is **not yet tagged for release**. Once a Go release is published:

```sh
go get github.com/zentered-studios/mcpsignals/packages/go@latest
```

Until then, use `@main` instead of `@latest` to resolve a pseudo-version. To
try it from a local checkout:

```sh
git clone https://github.com/zentered-studios/mcpsignals.git
cd mcpsignals/packages/go
go test -race ./...
go run ./examples/stdio
```

The example waits for an MCP client on stdin. To use the local checkout from
another module, run `go mod edit` there with an absolute path:

```sh
go mod edit -replace github.com/zentered-studios/mcpsignals/packages/go=/absolute/path/to/mcpsignals/packages/go
go get github.com/zentered-studios/mcpsignals/packages/go
```

## Enable instrumentation

```go
info := &mcp.Implementation{Name: "my-server", Version: "1.0.0"}
server := mcp.NewServer(info, nil)
telemetry, err := mcpsignals.Instrument(server, mcpsignals.Options{
    ServerName: info.Name,
    ServerVersion: info.Version,
    Transport: "stdio",
    Buffer: mcpsignals.BufferOptions{
        Sinks: []mcpsignals.Sink{mcpsignals.NewConsoleSink(nil)},
    },
})
if err != nil {
    return err
}
// Existing server.AddTool and mcp.AddTool registrations are unchanged.
// Register tools, then run server. See examples/stdio/main.go for a full program.
```

Imports:

```go
import (
    "github.com/modelcontextprotocol/go-sdk/mcp"
    mcpsignals "github.com/zentered-studios/mcpsignals/packages/go"
)
```

`Instrument` returns the same server in `telemetry.Server`. Call it **once per
server**, before connecting clients. It observes tools registered both before
and after instrumentation. The SDK's receiving middleware chain is the supported
extension point; no handlers are replaced. Each `AddReceivingMiddleware` call
wraps the existing chain. Install mcpsignals last to observe errors from other
middleware too. Install it first if `ResolveIdentity` reads context values that
other receiving middleware adds.

Supply the server's actual advertised name/version: the SDK keeps its
`Implementation` private. The library returns the exact handler result/error
and passes the original request and context through. Handler panics propagate
unchanged and do not produce an event. Telemetry callback panics are suppressed;
sink failures are isolated from tool outcomes.

## Lifecycle and delivery

Stop accepting and drain MCP requests **before** closing telemetry. An active
handler finishing after `Close` is not recorded. There is no process-exit hook.
Use a fresh context, not a canceled request/server context:

```go
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
if err := telemetry.Close(ctx); err != nil {
    // Report the delivery failure according to your application's logging policy.
}
```

- Defaults: size threshold **20**, interval **5 seconds**, queue capacity
  **1000 pending events**, automatic write timeout **10 seconds**.
- One background worker performs sink writes, never the request goroutine.
  The queue drops the newest event on overflow; an in-flight batch is separate.
  `telemetry.Stats()` reports `Dropped` and `SinkErrors`, without logging payloads.
  `Dropped` counts events rejected by a full queue or a closed buffer.
- `Buffer.Manual: true` disables **both size and interval triggers**, starts no
  worker, and requires explicit `Flush(ctx)`/`Close(ctx)`.
- `Flush` waits for earlier writes, then attempts the queued batch. Calls are
  serialized. `Close` stops acceptance/automatic flushing and drains pending
  and in-flight writes. A timed-out close can be retried with a fresh context.
- Delivery is **best-effort, at-most-one attempt per sink**. A failed batch is
  discarded, not retried: partial writes could otherwise be duplicated.
  Explicit flush/close return errors for batches they attempt; earlier automatic
  failures remain visible in `Stats`. A healthy sink still receives a batch when
  another sink errors or panics.
- Sinks are called sequentially and **must honor context cancellation**. Contexts
  cannot interrupt arbitrary Go callbacks or a blocked `io.Writer`; an
  uncooperative sink can delay flush/close and subsequent sinks, but not tool
  responses. The console sink checks context between events.
- `Close` does not close application-owned sinks, DB pools, or writers. Do that
  separately after draining. `EventBuffer` is also available for direct events;
  callers own schema correctness and must not mutate accepted event data.

## Privacy

`CaptureArguments` defaults to false, producing `arguments: null`. When enabled,
a call without arguments records `{}`, as in Node/Python, and only top-level
keys and JSON type markers are captured by default:

```go
CaptureArguments: true,
Redaction: mcpsignals.Redaction{
    Allow: []string{"limit"},
    Deny: []string{"token"},
},
```

`Deny` wins over `Allow`. Allowing an object/array allows its entire value, so
allow only fields safe to store. Type markers are `string`, `number`, `boolean`,
`object`, `array`, and `null`.

A `Redactor func(map[string]any) (map[string]any, error)` overrides both lists.
It receives a detached JSON object (numbers are `json.Number`); it cannot mutate
handler input. Its output is serialized immediately. Errors, panics, nil output,
or invalid/unserializable output record `arguments: null`, never raw fallback.

`ResolveIdentity func(context.Context, mcpsignals.CallContext) (mcpsignals.Identity, error)`
is the **only** source of `user_id` and `org_id`. Use application-verified identity,
not untrusted tool arguments/client names. With the SDK's `auth.RequireBearerToken`,
read `CallContext.TokenInfo` (for example `TokenInfo.UserID`). `CallContext.Header`
holds a copy of the HTTP request headers. The resolver cannot see context values
added by receiving middleware installed before `Instrument`: that middleware
runs inside mcpsignals. Failure or panic
records null identity. Both callbacks run on the request goroutine after the
handler returns, so they delay the response but not the handler or `ts`. They
must be fast/nonblocking and concurrency-safe, and must not mutate shared
configuration.
The library does not log callback error text, which might contain secrets.

Error messages are still captured (up to 2000 Unicode characters). Argument
redaction does not scrub error messages or explicitly allowed values.

## Event and metadata contract

See [`schema/events.md`](../../schema/events.md) and the
[source-verification notes](../../docs/go-sdk.md).

- One `tool_call` event per incoming `tools/call` that reaches the middleware.
  Requests rejected by the SDK before middleware execution cannot be observed.
  Calls to unregistered tool names (the SDK's `unknown tool` error) are not
  recorded, matching Node/Python.
  A multi-round-trip call records one event, for the leg that completes. An
  `input_required` leg is not recorded, so `duration_ms` covers the final leg.
- `ts` is UTC at handler-chain entry, truncated to the millisecond like Node's
  `toISOString`. `duration_ms` measures that chain using
  Go's monotonic clock, excluding redaction/identity resolution and sink writes.
  It rounds to the nearest millisecond, like Node.
- `success` follows `CallToolResult.IsError`; an SDK/handler error returned without
  a result is also a failure, with `response_bytes: 0`.
- `request_bytes` counts raw JSON argument bytes exposed to middleware (0 when
  omitted). `response_bytes` counts JSON serialization of the result at the
  middleware boundary, including structured content. These are **not complete
  wire bytes**: SDK-added response metadata/JSON-RPC framing are excluded.
  Unserializable results record 0 without changing the result.
- Client metadata uses `CallToolRequest.ClientInfo()`: legacy handshake or newer
  per-request identity. Client name/version and request tool names are capped at
  128 Unicode characters. Empty optional strings serialize as null.
- Session IDs come only from `ServerSession.ID()`, null when absent (including
  stdio and new stateless HTTP). HTTP is detected from `RequestExtra.Header`.
  Without HTTP headers, `transport` is `Options.Transport`, or `stdio` when unset,
  as in Node/Python. The legacy SSE transport exposes no headers to middleware:
  set `Transport: "http"` for it. An actual HTTP request takes precedence over
  a configured value.
- `agent_id` and `intent` are null. No schemas are injected or arguments stripped.

To declare an error category, return `IsError: true` with
`Meta: mcp.Meta{mcpsignals.ErrorKindMetaKey: string(mcpsignals.AuthRequired)}`.
The meta field is passed to clients unchanged. Unknown categories use the shared
message heuristic. Categories are ignored on successful results.

The heuristic deliberately matches Node/Python, including their limitations:
SDK errors worded `validating "arguments": ...` can classify as `internal` when
they contain none of the shared validation keywords. `success: false` remains
authoritative. Use declared categories for precise application failures.

## Feature parity and deferred work

| Feature | Go | Node.js / Python |
|---|---|---|
| Shared tool-call contract, privacy controls, declared error kinds | Implemented | Implemented |
| Console JSON lines / custom sinks | Implemented; console defaults to stderr | Implemented |
| Size/interval buffer, explicit flush/close | Implemented | Implemented |
| Manual mode | No automatic writes | Size trigger remains active |
| Postgres / BigQuery / OTLP built-in sinks | **Deferred** | Implemented |
| Intent capture / schema injection | **Deferred** | Implemented |
| D1 sink | Not planned for this integration | Node.js only |

Deferred features are tracked in [the Go implementation notes](../../docs/go-sdk.md#deferred-scope).
Use the public `Sink` interface for your own warehouse adapter:

```go
type Sink interface {
    Write(context.Context, []mcpsignals.ToolCallEvent) error
}
```

Treat event data as read-only, honor cancellation, and avoid retries unless your
sink implements deduplication. There are no built-in warehouse credentials to set.

## Verify and publish

```sh
cd packages/go
test -z "$(gofmt -l .)"
go mod tidy -diff
go vet ./...
go test -race ./...
go build ./...
```

The subprocess test builds and runs the stdio example with an official SDK client.
HTTP tests use loopback. Publishing uses an independent, directory-prefixed Git
tag, **not npm/PyPI credentials or the root release tag**. See
[the publishing checklist](../../docs/go-sdk.md#publishing).
