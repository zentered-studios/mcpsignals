import asyncio
import dataclasses
import json
import logging
import sys
from datetime import datetime, timedelta, timezone

import pytest
from mcp.client.client import Client
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import CallToolResult, Implementation, TextContent
from mcpsignals import ERROR_KIND_META_KEY, InstrumentHandle, handle_for, instrument
from mcpsignals.events import ToolCallEvent
from mcpsignals.intent_capture import MAX_IDENTIFIER_LENGTH, MAX_INTENT_LENGTH
from mcpsignals.redaction import RedactionConfig
from starlette.applications import Starlette
from starlette.routing import Mount

# mcp>=2.x depends on the `httpx2` fork; an older resolution ships `httpx`. Same API.
try:
    import httpx2 as httpx
except ImportError:  # pragma: no cover - depends on how `mcp` resolved
    import httpx


class RecordingSink:
    def __init__(self):
        self.events: list[ToolCallEvent] = []

    async def write(self, events):
        self.events.extend(events)


def build_server(**instrument_kwargs):
    server = MCPServer("test-server")
    sink = RecordingSink()
    instrument(
        server,
        server_name="test-server",
        server_version="1.2.3",
        sinks=[sink],
        buffer_size=1,
        **instrument_kwargs,
    )
    return server, sink


@pytest.mark.asyncio
async def test_success_path_records_event():
    server, sink = build_server()

    @server.tool()
    def add(a: int, b: int) -> int:
        return a + b

    async with Client(
        server, client_info=Implementation(name="test-client", version="9.9")
    ) as client:
        result = await client.call_tool("add", {"a": 1, "b": 2})
        await asyncio.sleep(0.05)

    assert not result.is_error
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event.tool_name == "add"
    assert event.server_name == "test-server"
    assert event.server_version == "1.2.3"
    assert event.success is True
    assert event.error_kind is None
    assert event.error_message is None
    assert event.client_name == "test-client"
    assert event.client_version == "9.9"
    assert event.transport == "stdio"
    assert event.request_bytes > 0
    assert event.response_bytes > 0
    assert event.arguments is None  # capture_arguments defaults to False


@pytest.mark.asyncio
async def test_error_path_raised_exception_records_failure():
    # ToolError (not a bare exception) is what the mcp SDK requires for an
    # anticipated failure's message to reach the client at all: a bare
    # exception is treated as a crash and the client only ever sees
    # "Error executing tool <name>", with the original text withheld -
    # verified against the installed mcp package's
    # mcp/server/mcpserver/exceptions.py docstrings.
    server, sink = build_server()

    @server.tool()
    def boom() -> str:
        raise ToolError("record with that id was not found")

    async with Client(server) as client:
        result = await client.call_tool("boom", {})
        await asyncio.sleep(0.05)

    assert result.is_error  # the library must not change what the caller sees
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event.success is False
    assert event.error_kind == "not_found"
    assert "not found" in event.error_message


@pytest.mark.asyncio
async def test_error_path_unanticipated_crash_withholds_message():
    # A bare exception (as opposed to ToolError above) is an unanticipated
    # crash: the SDK deliberately withholds its message from the client, so
    # classify_error has nothing to match and falls back to "internal".
    server, sink = build_server()

    @server.tool()
    def boom() -> str:
        raise ValueError("record with that id was not found")

    async with Client(server) as client:
        result = await client.call_tool("boom", {})
        await asyncio.sleep(0.05)

    assert result.is_error
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event.success is False
    assert event.error_kind == "internal"
    assert "not found" not in event.error_message


@pytest.mark.asyncio
async def test_error_path_explicit_is_error_result_records_failure():
    server, sink = build_server()

    @server.tool()
    def rejects(query: str) -> str:
        return query

    async with Client(server) as client:
        # Omitting the required `query` argument triggers the SDK's own
        # schema validation, which returns isError:true without ever
        # reaching our handler wrapper's try/except - exercises the
        # non-exception error path.
        result = await client.call_tool("rejects", {})
        await asyncio.sleep(0.05)

    assert result.is_error
    assert len(sink.events) == 1
    assert sink.events[0].success is False


@pytest.mark.asyncio
async def test_explicit_error_kind_auth_required_keeps_message():
    server, sink = build_server()

    @server.tool()
    def fee() -> CallToolResult:
        return CallToolResult(
            content=[
                TextContent(type="text", text="Sign in at https://example.com to use this tool.")
            ],
            is_error=True,
            _meta={ERROR_KIND_META_KEY: "auth_required"},
        )

    async with Client(server) as client:
        result = await client.call_tool("fee", {})
        await handle_for(server).flush()

    assert result.content[0].text == "Sign in at https://example.com to use this tool."
    assert sink.events[0].success is False
    assert sink.events[0].error_kind == "auth_required"


@pytest.mark.asyncio
async def test_explicit_error_kind_payment_required():
    server, sink = build_server()

    @server.tool()
    def fee() -> CallToolResult:
        return CallToolResult(
            content=[TextContent(type="text", text="Get filing fee requires an active plan.")],
            is_error=True,
            _meta={ERROR_KIND_META_KEY: "payment_required"},
        )

    async with Client(server) as client:
        await client.call_tool("fee", {})
        await handle_for(server).flush()

    assert sink.events[0].success is False
    assert sink.events[0].error_kind == "payment_required"


@pytest.mark.asyncio
async def test_explicit_error_kind_wins_over_message_heuristic():
    server, sink = build_server()

    @server.tool()
    def fee() -> CallToolResult:
        return CallToolResult(
            content=[TextContent(type="text", text="No current fee on file for that form.")],
            is_error=True,
            _meta={ERROR_KIND_META_KEY: "not_found"},
        )

    async with Client(server) as client:
        await client.call_tool("fee", {})
        await handle_for(server).flush()

    assert sink.events[0].error_kind == "not_found"


@pytest.mark.asyncio
async def test_unknown_explicit_error_kind_falls_back_to_heuristic():
    server, sink = build_server()

    @server.tool()
    def fee() -> CallToolResult:
        return CallToolResult(
            content=[TextContent(type="text", text="widget not found")],
            is_error=True,
            _meta={ERROR_KIND_META_KEY: "teapot"},
        )

    async with Client(server) as client:
        await client.call_tool("fee", {})
        await handle_for(server).flush()

    assert sink.events[0].error_kind == "not_found"


@pytest.mark.asyncio
async def test_explicit_error_kind_on_successful_result_is_ignored():
    server, sink = build_server()

    @server.tool()
    def fee() -> CallToolResult:
        return CallToolResult(
            content=[TextContent(type="text", text="ok")],
            _meta={ERROR_KIND_META_KEY: "auth_required"},
        )

    async with Client(server) as client:
        await client.call_tool("fee", {})
        await handle_for(server).flush()

    assert sink.events[0].success is True
    assert sink.events[0].error_kind is None


@pytest.mark.asyncio
async def test_sink_failure_does_not_break_tool_response():
    class FailingSink:
        async def write(self, events):
            raise RuntimeError("warehouse is down")

    server = MCPServer("test-server")
    instrument(server, server_name="test-server", sinks=[FailingSink()], buffer_size=1)

    @server.tool()
    def add(a: int, b: int) -> int:
        return a + b

    async with Client(server) as client:
        # Must not raise even though the only sink always fails.
        result = await client.call_tool("add", {"a": 1, "b": 2})

    assert not result.is_error


@pytest.mark.asyncio
async def test_redaction_default_records_types_not_values():
    server, sink = build_server(capture_arguments=True)

    @server.tool()
    def search(query: str) -> str:
        return query

    async with Client(server) as client:
        await client.call_tool("search", {"query": "secret plans"})
        await asyncio.sleep(0.05)

    assert sink.events[0].arguments == {"query": {"__type": "string"}}


@pytest.mark.asyncio
async def test_intent_capture_off_by_default_leaves_schema_and_args_untouched():
    server, sink = build_server()

    @server.tool()
    def search(query: str) -> str:
        return query

    async with Client(server) as client:
        tools = await client.list_tools()
        schema_props = set(tools.tools[0].input_schema.get("properties", {}).keys())
        assert schema_props == {"query"}  # no injected fields when disabled


@pytest.mark.asyncio
async def test_intent_capture_injects_schema_and_strips_before_handler():
    server, sink = build_server(intent_capture=True)
    received = {}

    @server.tool()
    def search(query: str) -> str:
        received["args"] = {"query": query}
        return query

    async with Client(server) as client:
        tools = await client.list_tools()
        schema_props = set(tools.tools[0].input_schema.get("properties", {}).keys())
        assert schema_props == {"query", "session_id", "agent_id", "intent"}

        await client.call_tool(
            "search",
            {
                "query": "mugs",
                "session_id": "sess-1",
                "agent_id": "agent-1",
                "intent": "user asked",
            },
        )
        await asyncio.sleep(0.05)

    # Provably transparent: the handler receives EXACTLY the args it would
    # have received without the library.
    assert received["args"] == {"query": "mugs"}

    event = sink.events[0]
    assert event.session_id == "sess-1"
    assert event.agent_id == "agent-1"
    assert event.intent == "user asked"


@pytest.mark.asyncio
async def test_intent_capture_truncates_oversized_values_before_the_sink():
    server, sink = build_server(intent_capture=True)

    @server.tool()
    def search(query: str) -> str:
        return query

    async with Client(server) as client:
        await client.call_tool(
            "search",
            {
                "query": "mugs",
                "session_id": "s" * 5000,
                "agent_id": "a" * 5000,
                "intent": "i" * 5000,
            },
        )
        await asyncio.sleep(0.05)

    event = sink.events[0]
    assert event.session_id == "s" * MAX_IDENTIFIER_LENGTH
    assert event.agent_id == "a" * MAX_IDENTIFIER_LENGTH
    assert event.intent == "i" * MAX_INTENT_LENGTH


@pytest.mark.asyncio
async def test_intent_capture_per_tool_override():
    server, sink = build_server(intent_capture=False, intent_capture_tools={"search": True})

    @server.tool()
    def search(query: str) -> str:
        return query

    @server.tool()
    def other(x: str) -> str:
        return x

    async with Client(server) as client:
        tools = {t.name: t for t in (await client.list_tools()).tools}
        assert "intent" in tools["search"].input_schema.get("properties", {})
        assert "intent" not in tools["other"].input_schema.get("properties", {})


@pytest.mark.asyncio
async def test_handle_for_returns_handle_only_for_instrumented_server():
    server = MCPServer("test-server")
    assert handle_for(server) is None

    returned = instrument(server, server_name="test-server", sinks=[RecordingSink()])
    assert returned is server  # return value unchanged: non-breaking

    handle = handle_for(server)
    assert isinstance(handle, InstrumentHandle)
    assert handle_for(server) is handle
    assert handle_for(MCPServer("other")) is None


@pytest.mark.asyncio
async def test_handle_flush_delivers_buffered_events():
    server = MCPServer("test-server")
    sink = RecordingSink()
    instrument(server, server_name="test-server", sinks=[sink], buffer_size=1000)

    @server.tool()
    def add(a: int, b: int) -> int:
        return a + b

    async with Client(server) as client:
        await client.call_tool("add", {"a": 1, "b": 2})
        await asyncio.sleep(0.05)
        assert sink.events == []  # below the size threshold, nothing flushed yet

        await handle_for(server).flush()

    assert len(sink.events) == 1
    assert sink.events[0].tool_name == "add"


@pytest.mark.asyncio
async def test_manual_mode_has_no_interval_task_and_no_atexit_hook(monkeypatch):
    import mcpsignals.buffer as buffer_module

    registered: list = []
    monkeypatch.setattr(buffer_module.atexit, "register", lambda fn, *a, **k: registered.append(fn))

    server = MCPServer("test-server")
    sink = RecordingSink()
    instrument(
        server, server_name="test-server", sinks=[sink], buffer_size=1000, flush_interval_s=None
    )

    @server.tool()
    def add(a: int, b: int) -> int:
        return a + b

    async with Client(server) as client:
        await client.call_tool("add", {"a": 1, "b": 2})
        await asyncio.sleep(0.05)

    handle = handle_for(server)
    assert handle._buffer._interval_task is None
    assert registered == []
    assert sink.events == []
    await handle.flush()
    assert len(sink.events) == 1


@pytest.mark.asyncio
async def test_handle_close_flushes_cancels_task_unregisters_atexit(monkeypatch):
    import mcpsignals.buffer as buffer_module

    unregistered: list = []
    monkeypatch.setattr(buffer_module.atexit, "unregister", lambda fn: unregistered.append(fn))

    server = MCPServer("test-server")
    sink = RecordingSink()
    instrument(server, server_name="test-server", sinks=[sink], buffer_size=1000)

    @server.tool()
    def add(a: int, b: int) -> int:
        return a + b

    async with Client(server) as client:
        await client.call_tool("add", {"a": 1, "b": 2})
        await asyncio.sleep(0.05)

    handle = handle_for(server)
    task = handle._buffer._interval_task
    assert task is not None
    assert sink.events == []

    await handle.close()
    assert len(sink.events) == 1
    assert task.cancelled()
    assert handle._buffer._interval_task is None
    assert unregistered == [handle._buffer._atexit_flush]

    await handle.close()  # second close must not raise
    assert len(sink.events) == 1


# Telemetry failure isolation (#25): nothing the library does around a tool
# call may change what the client receives. Each test below breaks one
# library-side step and asserts the handler's own result still comes back,
# the event still lands, and the failure is logged once per instrument() call.


def _mcpsignals_records(caplog):
    return [record for record in caplog.records if record.name == "mcpsignals"]


@pytest.mark.asyncio
async def test_raising_redactor_never_reaches_the_client(caplog):
    def exploding_redactor(args):
        raise RuntimeError("redactor exploded")

    server, sink = build_server(
        capture_arguments=True, redaction=RedactionConfig(redactor=exploding_redactor)
    )

    @server.tool()
    def search(query: str) -> str:
        return query

    with caplog.at_level(logging.ERROR, logger="mcpsignals"):
        async with Client(server) as client:
            first = await client.call_tool("search", {"query": "secret plans"})
            second = await client.call_tool("search", {"query": "secret plans"})
            await asyncio.sleep(0.05)

    assert not first.is_error
    assert first.content[0].text == "secret plans"
    assert not second.is_error
    assert second.content[0].text == "secret plans"

    assert len(sink.events) == 2
    for event in sink.events:
        assert event.success is True
        # A failed redactor must never fall back to the raw arguments.
        assert event.arguments is None

    records = _mcpsignals_records(caplog)
    assert len(records) == 1, "logged once per instrument() call, not per event"
    assert "redactor exploded" in records[0].getMessage()


@pytest.mark.asyncio
async def test_raising_resolve_identity_never_reaches_the_client(caplog):
    def exploding_identity(ctx):
        raise RuntimeError("identity service down")

    server, sink = build_server(resolve_identity=exploding_identity)

    @server.tool()
    def add(a: int, b: int) -> int:
        return a + b

    with caplog.at_level(logging.ERROR, logger="mcpsignals"):
        async with Client(server) as client:
            first = await client.call_tool("add", {"a": 1, "b": 2})
            second = await client.call_tool("add", {"a": 2, "b": 3})
            await asyncio.sleep(0.05)

    assert not first.is_error
    assert first.content[0].text == "3"
    assert not second.is_error
    assert second.content[0].text == "5"

    assert len(sink.events) == 2
    for event in sink.events:
        assert event.success is True
        assert event.user_id is None
        assert event.org_id is None

    records = _mcpsignals_records(caplog)
    assert len(records) == 1
    assert "identity service down" in records[0].getMessage()


# Timing (#27): `duration_ms` is wall time from call start to response
# (schema/events.md), so `resolve_identity` runs after the handler, outside
# the timed window. `ts` stays anchored at call start.


@pytest.mark.asyncio
async def test_duration_ms_excludes_resolve_identity():
    order: list[str] = []

    async def slow_identity(ctx):
        await asyncio.sleep(0.2)
        order.append("resolver")
        return ("u-1", "o-1")

    server, sink = build_server(resolve_identity=slow_identity)

    @server.tool()
    def instant() -> str:
        order.append("handler")
        return "ok"

    async with Client(server) as client:
        result = await client.call_tool("instant", {})
        await asyncio.sleep(0.05)

    assert result.content[0].text == "ok"
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event.duration_ms < 100, f"duration_ms {event.duration_ms} includes the resolver"
    # The resolver still ran, after the handler, and its result lands on the event.
    assert order == ["handler", "resolver"]
    assert event.user_id == "u-1"
    assert event.org_id == "o-1"


@pytest.mark.asyncio
async def test_ts_is_when_the_call_started_not_when_it_finished():
    handler_end: list[datetime] = []

    server, sink = build_server()

    @server.tool()
    async def slow() -> str:
        await asyncio.sleep(0.05)
        handler_end.append(datetime.now(timezone.utc))
        return "ok"

    async with Client(server) as client:
        await client.call_tool("slow", {})
        await asyncio.sleep(0.05)

    assert len(sink.events) == 1
    event = sink.events[0]
    assert handler_end
    assert event.ts <= handler_end[0] - timedelta(milliseconds=40), (
        f"ts {event.ts.isoformat()} is not at least 40 ms before the handler "
        f"finished at {handler_end[0].isoformat()}"
    )


# Bounds (#19): `client_name`/`client_version` come from the client's
# `initialize` handshake and `tool_name` straight from the `tools/call`
# request, so all three are caller-controlled like the intent fields and take
# the same 128-char identifier cap. Truncated, never dropped.


@pytest.mark.asyncio
async def test_client_name_and_version_are_truncated_to_the_identifier_cap():
    server, sink = build_server()

    @server.tool()
    def ping() -> str:
        return "ok"

    async with Client(
        server, client_info=Implementation(name="c" * 5000, version="v" * 5000)
    ) as client:
        await client.call_tool("ping", {})
        await asyncio.sleep(0.05)

    assert len(sink.events) == 1
    event = sink.events[0]
    assert event.client_name == "c" * MAX_IDENTIFIER_LENGTH
    assert event.client_version == "v" * MAX_IDENTIFIER_LENGTH


@pytest.mark.asyncio
async def test_tool_name_from_the_request_is_truncated_to_the_identifier_cap():
    server, sink = build_server()

    @server.tool()
    def ping() -> str:
        return "ok"

    async with Client(server) as client:
        # No tool is registered under this name, so the call fails, but the
        # failed event is still recorded with the name the client sent.
        try:
            result = await client.call_tool("t" * 5000, {})
        except Exception:  # noqa: BLE001 - the SDK's error shape is not what is under test
            result = None
        await asyncio.sleep(0.05)

    assert result is None or result.is_error
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event.success is False
    assert event.tool_name == "t" * MAX_IDENTIFIER_LENGTH


# Identity: `resolve_identity` may return the tuple directly or as an
# awaitable. The awaitable path is asserted in the duration test above; this
# pins the sync path and that the resolver receives the middleware context.


@pytest.mark.asyncio
async def test_sync_resolve_identity_lands_on_the_event():
    seen: list[str] = []

    def identity(ctx):
        seen.append(ctx.method)
        return ("u-sync", "o-sync")

    server, sink = build_server(resolve_identity=identity)

    @server.tool()
    def whoami() -> str:
        return "ok"

    async with Client(server) as client:
        result = await client.call_tool("whoami", {})
        await asyncio.sleep(0.05)

    assert not result.is_error
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event.user_id == "u-sync"
    assert event.org_id == "o-sync"
    assert seen == ["tools/call"]


# Transport: the SDK attaches the Starlette request to the middleware context
# only on the streamable HTTP path, and the middleware maps that to
# `transport="http"`. Driven through the real ASGI app with the same JSON-RPC
# body the example READMEs send with curl.


@pytest.mark.asyncio
async def test_transport_is_http_over_the_streamable_http_app():
    server, sink = build_server()

    @server.tool()
    def add_note(text: str) -> str:
        return f"Saved: {text}"

    # Same shape as examples/python-starlette/server.py. `stateless_http=True`
    # so a bare `tools/call` needs no `initialize` handshake first.
    app = Starlette(routes=[Mount("/", app=server.streamable_http_app(stateless_http=True))])
    body = (
        '{"jsonrpc":"2.0","id":1,"method":"tools/call",'
        '"params":{"name":"add_note","arguments":{"text":"hello from curl"}}}'
    )

    # `ASGITransport` never runs the ASGI lifespan, so the session manager is
    # started here directly instead of through a Starlette `lifespan=`. The
    # SDK's DNS rebinding protection for `host="127.0.0.1"` allows
    # `127.0.0.1:*` only, so the base URL carries a port like the curl does.
    async with server.session_manager.run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8001"
        ) as client:
            response = await client.post(
                "/mcp",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                },
                content=body,
            )
        await asyncio.sleep(0.05)

    assert response.status_code == 200, response.text
    assert "Saved: hello from curl" in response.text
    assert len(sink.events) == 1
    event = sink.events[0]
    assert event.tool_name == "add_note"
    assert event.success is True
    assert event.transport == "http"


# A redactor is a full override: whatever it returns is recorded verbatim, and
# nothing stops it returning a value `json` cannot encode. Every sink
# re-serializes `arguments` on its way out (`json.dumps` in postgres and
# bigquery, `dataclasses.asdict` then `json.dumps` in the console sink), so
# such a value made the sink raise from inside `EventBuffer._write_to_sink`,
# which drops the whole batch - including the unrelated events flushed
# alongside it. The event is kept with `arguments=None` instead, the same
# fallback a raising redactor already had.


def _circular() -> dict:
    circular: dict = {"name": "x"}
    circular["self"] = circular
    return circular


@pytest.mark.asyncio
async def test_unserializable_redactor_output_records_arguments_none():
    server, sink = build_server(
        capture_arguments=True,
        redaction=RedactionConfig(redactor=lambda args: _circular()),
    )

    @server.tool()
    def echo(text: str) -> str:
        return text

    async with Client(server) as client:
        result = await client.call_tool("echo", {"text": "hi"})
        await asyncio.sleep(0.05)

    assert not result.is_error, "the tool result must be unaffected"
    assert len(sink.events) == 1
    assert sink.events[0].arguments is None


@pytest.mark.asyncio
async def test_unserializable_redactor_never_costs_the_rest_of_the_flush():
    written: list = []

    class SerializingSink:
        """Serializes like every real sink does, so this fails the way a
        console/postgres/bigquery flush failed rather than only pinning the
        field.
        """

        async def write(self, events):
            json.dumps([dataclasses.asdict(e) for e in events], default=str)
            written.extend(events)

    def redactor(args):
        return _circular() if args.get("text") == "poison" else {"text": "kept"}

    server = MCPServer("test-server")
    instrument(
        server,
        server_name="test-server",
        sinks=[SerializingSink()],
        buffer_size=2,  # hold both calls, flush them to the sink as one batch
        capture_arguments=True,
        redaction=RedactionConfig(redactor=redactor),
    )

    @server.tool()
    def echo(text: str) -> str:
        return text

    async with Client(server) as client:
        await client.call_tool("echo", {"text": "poison"})
        await client.call_tool("echo", {"text": "fine"})
        await asyncio.sleep(0.05)

    assert len(written) == 2, "both events must reach the sink"
    assert written[0].arguments is None, "the unserializable one is recorded as None"
    assert written[1].arguments == {"text": "kept"}, "the healthy one is untouched"


def test_declared_error_kind_reads_snake_case_meta():
    from mcpsignals.instrument import _declared_error_kind

    result = {"is_error": True, "meta": {ERROR_KIND_META_KEY: "auth_required"}}
    assert _declared_error_kind(result) == "auth_required"


@pytest.mark.asyncio
async def test_declared_error_kind_that_raises_still_records_the_failed_call(monkeypatch):
    def boom(result):
        raise RuntimeError("boom")

    # `mcpsignals.instrument` the attribute is the function; patch the module.
    monkeypatch.setattr(sys.modules["mcpsignals.instrument"], "_declared_error_kind", boom)
    server, sink = build_server()

    @server.tool()
    def fee() -> CallToolResult:
        return CallToolResult(
            content=[TextContent(type="text", text="widget not found")],
            is_error=True,
        )

    async with Client(server) as client:
        await client.call_tool("fee", {})
        await handle_for(server).flush()

    assert len(sink.events) == 1
    assert sink.events[0].success is False
    assert sink.events[0].error_kind == "not_found"
