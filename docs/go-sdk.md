# Go SDK integration: verified design and release notes

Implements [issue #84](https://github.com/zentered-studios/mcpsignals/issues/84).
The Go module lives at `packages/go`; package name `mcpsignals`, module path
`github.com/zentered-studios/mcpsignals/packages/go`.

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
| [shared.go](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/shared.go) | Use request-local `ClientInfo()`, `RequestExtra.Header`, and `ServerSession.ID()`. Never read identity from argument/header guesses. |
| [Protocol docs](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/docs/protocol.md) and [protocol types](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/protocol.go) | Legacy handshake and newer stateless metadata differ; cancellation flows through context; wire-only response annotations happen after receiving middleware. |
| [Streamable HTTP implementation](https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/mcp/streamable.go) | New protocol HTTP tests must enable `Stateless`; default stateful HTTP negotiates legacy behavior. |
| [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling) | Tool errors use `isError`; protocol errors are distinct. Preserve both outcomes. |
| [MCP transports specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio) | Stdout is reserved for MCP; console sink defaults to stderr. |
| [Shared event contract](../schema/events.md) and existing Node/Python implementations | Snake-case fields, explicit nulls, same redaction markers and ordered error heuristics. |
| [Go module version mapping](https://go.dev/ref/mod#vcs-version) and [publishing](https://go.dev/doc/modules/publishing) | A subdirectory module needs `packages/go/vX.Y.Z` tags; no registry account/token. |

## Design boundaries

- Middleware records one completed invocation, not an aggregated conversation.
  SDK rejection before dispatch and handler panics are outside event coverage.
- Explicit server name/version avoids reflection/private SDK fields. Unknown
  transport/session data remains null. `intent`/`agent_id` remain null.
- Snapshot captured arguments before invoking the next handler. Redactors cannot
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

**Nothing in this change publishes the module or modifies the existing npm/PyPI
release workflow.** The proposed first Go version is **v0.1.0**, independent of
Node/Python's version. Root `vX.Y.Z` tags do not version this subdirectory module.

What is needed from the maintainer:

1. Review/merge the Go PR with green CI.
2. Approve the module path above and initial version (`v0.1.0` proposed).
3. Authorize publishing and ensure the publishing identity may create/push the
   `packages/go/v*` tag (including any GitHub tag-ruleset requirements).

No npm token, PyPI token, Go registry account, new repository, or cloud credentials
are needed. The repository must remain publicly readable. The module includes its
MIT license so package documentation can display it.

Once approved, from a clean release worktree at the reviewed merge commit:

```sh
cd packages/go
go mod tidy -diff
go vet ./...
go test -race ./...
go build ./...
cd ../..
git tag -a packages/go/v0.1.0 -m "Release mcpsignals Go v0.1.0"
git push origin packages/go/v0.1.0
GOPROXY=https://proxy.golang.org go list -m github.com/zentered-studios/mcpsignals/packages/go@v0.1.0
```

Verify installation from a fresh external module (no `replace` directive):

```sh
mkdir /tmp/mcpsignals-go-release-check
cd /tmp/mcpsignals-go-release-check
go mod init example.com/release-check
go get github.com/zentered-studios/mcpsignals/packages/go@v0.1.0
go doc github.com/zentered-studios/mcpsignals/packages/go
```

Check the versioned page at
[pkg.go.dev](https://pkg.go.dev/github.com/zentered-studios/mcpsignals/packages/go)
after indexing, then remove the unpublished notice from the package README. Never
move or replace a published tag: Go's checksum database makes releases immutable.
Future release automation can create these prefixed tags separately from the
current root-tag semantic-release workflow; it is not required for first publish.
