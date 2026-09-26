# mcpsignals (Python)

Drop-in instrumentation for MCP servers. Wrap your server, point it at a
sink, and it records what agents did with your tools into a database you
own - no hosted service, no account.

Requires **Python 3.10 or newer**. Targets the v2 `mcp` SDK (`MCPServer` /
low-level `Server`, `mcp>=2.0.0`).

## Install

```bash
pip install mcpsignals
# with a warehouse sink:
pip install "mcpsignals[postgres]"   # or [bigquery], [otlp]
```

## Usage

```python
from mcp.server.mcpserver import MCPServer
from mcpsignals import instrument

server = MCPServer("my-server")
instrument(server, server_name="my-server", server_version="1.0.0")


@server.tool()
def search(query: str) -> str:
    """Search something."""
    return f"results for {query}"
```

Call `instrument()` any time before the server starts handling requests. It
appends to `server.middleware`, and that chain is rebuilt from the live list
on every request, so calling it before or after your `@server.tool()`
definitions makes no difference. The Node.js package differs here: it reads
tool annotations and intent capture from wrapping `registerTool`, so it has
to run before any tool is registered.

With no sink configured it writes JSON lines to stdout. On a stdio
transport pass `sinks=[ConsoleSink(stream=sys.stderr)]`, because the MCP
spec reserves stdout for protocol messages. To write to your own warehouse
instead:

```python
from mcpsignals import instrument
from mcpsignals.sinks import PostgresSink

instrument(server, server_name="my-server", sinks=[PostgresSink(dsn="postgresql://...")])
```

## Argument capture and redaction

Off by default: no tool arguments are recorded unless you opt in with
`capture_arguments=True`. Even then, by default only argument **keys and
value types** are recorded, never values. See the root README's redaction
section before enabling this in anything handling real user data.

## Identity: `user_id` and `org_id`

`resolve_identity` is the only thing that ever fills in `user_id` and
`org_id`. Without it both stay `None` on every event.

```python
def resolve_identity(ctx):
    account = look_up_account(ctx)  # your auth layer, not ours
    return (account.id, account.org_id) if account else (None, None)


instrument(server, server_name="my-server", resolve_identity=resolve_identity)
```

It receives the middleware's `ServerRequestContext` and returns a
`(user_id, org_id)` tuple. It may be a plain function or a coroutine;
either is awaited correctly. Returning `(None, None)` records a null
identity, which is what the column means for an anonymous call.

The Node.js package differs here: it passes `{ sessionId }` rather than the
raw context, and returns an object. Porting a resolver between the two means
rewriting both ends. Note that the context Python hands you carries no
session id of its own, for the reason in the limitation below.

It runs **after** your handler settles, so a slow resolver never lands in
`duration_ms` (wall time from call start to response, per
[`schema/events.md`](../../schema/events.md)). A resolver that raises is
logged once and costs you the identity on that event, nothing else: the
event is still recorded, and your handler's result or exception reaches the
client untouched.

## Buffering and flush timing

Events are batched in memory rather than written one per call.
`buffer_size` (default 20) flushes after that many events;
`flush_interval_s` (default 5.0) flushes on a timer. Whichever comes first
wins, plus a best-effort `atexit` flush.

```python
instrument(
    server,
    server_name="my-server",
    sinks=[PostgresSink()],
    buffer_size=100,  # fewer, larger writes
    flush_interval_s=10.0,
)
```

Raising `buffer_size` trades memory and worst-case loss for fewer round
trips: a crash loses whatever is still buffered.

The `atexit` flush is best-effort only. It needs an event loop that may not
exist at interpreter shutdown, and it logs a warning and drops the buffer
when there is none. Anything that must not be lost should go through an
explicit `await handle_for(server).flush()` before you shut down.

`flush_interval_s=None` is manual mode, covered next.

## Request-scoped runtimes and manual flushing

`instrument()` returns the server unchanged. `handle_for(server)` returns an
`InstrumentHandle` with two coroutines: `flush()` delivers everything
buffered so far to every sink, and `close()` does a final flush, cancels the
interval task, and unregisters the `atexit` hook. The handle is held in a
weak registry keyed by the exact server object, so it lives as long as the
server does; `handle_for()` returns `None` for a server that never went
through `instrument()`.

On a long-lived process, ignore the handle: the interval task and the
`atexit` hook flush for you. Neither is reliable on a request-scoped host
(a serverless function, or a server built fresh per request): the process
can be frozen or discarded right after the response is sent, and `atexit`
does not correspond to "this invocation is ending".

Pass `flush_interval_s=None` for manual mode. The buffer then skips both the
interval task and the `atexit` hook, so the host owns every flush:

```python
from mcp.server.mcpserver import MCPServer
from mcpsignals import handle_for, instrument


async def handle_request(request):
    server = MCPServer("my-server")
    instrument(
        server,
        server_name="my-server",
        sinks=[...],
        flush_interval_s=None,  # manual mode: the host flushes explicitly
    )

    @server.tool()
    def search(query: str) -> str:
        return f"results for {query}"

    response = await serve(request, server)

    await handle_for(server).flush()  # before returning the response
    return response
```

Call `close()` instead of `flush()` when the server is done for good: at the
end of a test, or when a per-request server is discarded. In the default
interval mode, `close()` is also what stops the interval task and removes the
`atexit` hook, so a test suite that instruments many servers does not
accumulate either. Both `flush()` and `close()` are safe to await more than
once.

## `session_id`

On a stateful streamable HTTP connection, `session_id` is the
`Mcp-Session-Id` header the client sends with every request after
`initialize`. It wins over a `session_id` the calling agent supplies through
intent capture. On stdio there is no transport session, so `session_id` is
only set when intent capture is enabled and the agent supplies one.

## Full docs

See the [root README](../../README.md) for the redaction model, the sink
comparison, and intent capture, and [`schema/events.md`](../../schema/events.md)
for the event field reference.
