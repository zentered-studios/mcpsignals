import asyncio

import pytest
from mcp.client.client import Client
from mcp.server.mcpserver import MCPServer
from mcp.types import Implementation

from mcpsignals import instrument
from mcpsignals.events import ToolCallEvent


class RecordingSink:
    def __init__(self):
        self.events: list[ToolCallEvent] = []

    async def write(self, events):
        self.events.extend(events)


def build_server(**instrument_kwargs):
    server = MCPServer("test-server")
    sink = RecordingSink()
    instrument(server, server_name="test-server", server_version="1.2.3", sinks=[sink], buffer_size=1, **instrument_kwargs)
    return server, sink


@pytest.mark.asyncio
async def test_success_path_records_event():
    server, sink = build_server()

    @server.tool()
    def add(a: int, b: int) -> int:
        return a + b

    async with Client(server, client_info=Implementation(name="test-client", version="9.9")) as client:
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
    server, sink = build_server()

    @server.tool()
    def boom() -> str:
        raise ValueError("record with that id was not found")

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

    assert sink.events[0].arguments == {"query": {"__type": "str"}}


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
            {"query": "mugs", "session_id": "sess-1", "agent_id": "agent-1", "intent": "user asked"},
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
