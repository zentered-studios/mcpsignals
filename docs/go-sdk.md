# Go SDK integration: verified design and release notes

Implements [issue #84](https://github.com/zentered-studios/mcpsignals/issues/84).
The Go module lives at `packages/go`; package name `mcpsignals`, module path
`github.com/zentered-studios/mcpsignals/packages/go/v2`.

## Sources verified before implementation

Reviewed on 2026-09-26 against official SDK **v1.8.0**, commit
`3f3b699b2b67e1ed033a63d6651671dab53c2d32`. References are pinned, not moving
`main` links. The upstream source checkout is not vendored into this repository.

| Source | Verified decision |
|---|---|
| [SDK go.mod](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/go.mod) | Minimum Go 1.25.0; pin SDK v1.8.0. |
| [SDK README](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/README.md) | Official `mcp` package; supported protocol revisions through 2026-07-28. |
| [Server tool docs](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/docs/server.md#tools) | Both raw `Server.AddTool` and generic `mcp.AddTool` remain unchanged. Generic handlers convert ordinary errors to `IsError` results. |
| [Middleware example](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/examples/server/middleware/main.go) and [server.go](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/server.go) | Use `AddReceivingMiddleware`; no registration monkey-patching. Server implementation metadata is private. |
| [shared.go](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/shared.go) | Use request-local `ClientInfo()`, `RequestExtra.Header`, `RequestExtra.TokenInfo`, and `ServerSession.ID()`. Never read identity from argument/header guesses; pass token info and headers to the application's resolver. |
| [Protocol docs](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/docs/protocol.md) and [protocol types](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/protocol.go) | Legacy handshake and newer stateless metadata differ; cancellation flows through context; wire-only response annotations happen after receiving middleware. |
| [Streamable HTTP implementation](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/streamable.go) | New protocol HTTP tests must enable `Stateless`; default stateful HTTP negotiates legacy behavior. |
| [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling) | Tool errors use `isError`; protocol errors are distinct. Preserve both outcomes. |
| [MCP transports specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio) | Stdout is reserved for MCP; console sink defaults to stderr. |
| [Shared event contract](../schema/events.md) and existing Node/Python implementations | Snake-case fields, explicit nulls, same redaction markers and ordered error heuristics. |
| [Go module version mapping](https://go.dev/ref/mod#vcs-version) and [publishing](https://go.dev/doc/modules/publishing) | A subdirectory module needs `packages/go/vX.Y.Z` tags; no registry account/token. |

## Design boundaries

- Middleware records one completed invocation, not an aggregated conversation.
  SDK rejection before dispatch is outside event coverage. A handler panic is
  recorded as a failure, like a Node throw, then re-raised with the same value.
- Explicit server name/version avoids reflection/private SDK fields. Transport
  defaults to `stdio` without HTTP headers, as in Node/Python. Unknown session
  data remains null. `intent`/`agent_id` remain null.
- Keep the raw argument bytes the call arrived with; redact them and resolve
  identity after the handler returns, matching Node/Python. Redactors cannot
  mutate actual arguments; serialization failure fails closed. Large JSON
  integers retain precision via `json.Number`.
- One bounded event queue and one automatic-flush worker per handle. Size/interval
  triggers do not perform warehouse work on tool-response paths. Manual mode
  performs no automatic writes, an intentional difference from Node/Python.
- Sink writes are serialized, failures/panics are isolated, and dropped/failed
  deliveries are counted. No retries or durability claims. Context-aware sinks
  are required; arbitrary blocked user code cannot be forcibly canceled in Go.
- Explicit `Flush`/`Close` drain earlier writes. Applications stop and drain their
  server before closing instrumentation. No signal handlers/process hooks in the
  library; the example owns shutdown.

## Acceptance verification

- Shared event-field/type/null checks; Unicode bounds; all redaction modes;
  allow/deny precedence; fail-closed callbacks and serialization; integer precision.
- Official SDK client/server calls on both protocol generations: success,
  `IsError`, ordinary generic-handler errors, protocol errors, validation failures,
  cancellation, concurrent calls, HTTP metadata, and argument/result preservation.
- Direct middleware tests check identical request/context/result/error objects and
  unchanged panic propagation; blocked sinks do not delay tool responses.
- Buffer tests exercise manual/size/interval flushes, concurrent pushes, capacity,
  sink errors/panics, canceled flushes, in-flight writes, and close draining.
- A subprocess test builds the actual stdio example and uses the SDK client to
  verify MCP responses on stdout and JSON-line events on stderr.
- CI runs formatting, dependency tidiness, vet, race tests, and build (including
  example) on Go 1.25, 1.26, and 1.27. See the PR for actual run results.

## Deferred scope

Explicitly deferred from the first Go release of #84:

- Built-in Postgres sink: connection ownership, batching, and failure tests.
- Built-in BigQuery sink: credentials/insert semantics and integration tests.
- Built-in OTLP sink: current semantic-convention mapping and tracing ownership.
- Intent capture: schema injection/removal compatible with raw and typed SDK tools.

Custom sinks are supported now. D1 is not required/planned for this integration.
No placeholders claim these deferred features are implemented.

## Publishing

The Go module shares the root version number with the Node and Python packages.
Go has no registry: a `packages/go/vX.Y.Z` Git tag publishes the module, and
`proxy.golang.org` fetches it on first request. No token or registry account is
needed. The repository must stay publicly readable.

The release job in `.github/workflows/release.yml` pushes `packages/go/vX.Y.Z`
at the same commit as each root `vX.Y.Z` tag. Go-scoped commits (`feat(go)`,
`fix(go)`, `perf(go)`) cut a root release like any other scope, so a Go-only fix
also bumps the npm and PyPI versions.

Go puts major versions 2 and up in the import path. The module path ends in
`/v2`, and the release job fails before tagging if the release major does not
match that suffix. A major release (v3) therefore needs the `go.mod` module
path, the example import and the docs changed to `/v3` in the same release.

Never move or replace a published tag: Go's checksum database makes releases
immutable. The first Go tag, `packages/go/v2.3.2`, was pushed by hand after the
module was added; it has no matching Node/Python code at v2.3.2.

Verify a release from a fresh external module (no `replace` directive):

```sh
GOPROXY=https://proxy.golang.org go list -m github.com/zentered-studios/mcpsignals/packages/go/v2@vX.Y.Z
mkdir /tmp/mcpsignals-go-release-check && cd /tmp/mcpsignals-go-release-check
go mod init example.com/release-check
go get github.com/zentered-studios/mcpsignals/packages/go/v2@vX.Y.Z
go doc github.com/zentered-studios/mcpsignals/packages/go/v2
```
