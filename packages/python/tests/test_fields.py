import asyncio
import json

import httpx2 as httpx
import pytest
from mcp.client.client import Client
from mcp.shared.exceptions import MCPError
from mcp.types import ErrorData, ToolAnnotations
from mcpsignals.instrument import _error_code, _result_type, _tool_hints
from mcpsignals.trace_context import parse_traceparent
from starlette.applications import Starlette
from starlette.routing import Mount
from test_instrument import build_server

TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"


@pytest.mark.asyncio
async def test_protocol_version_request_id_and_result_type():
    server, sink = build_server()

    @server.tool()
    def echo(q: str) -> str:
        return q

    async with Client(server) as client:
        await client.call_tool("echo", {"q": "hi"})
        await asyncio.sleep(0.05)

    event = sink.events[0]
    assert event.protocol_version
    assert isinstance(event.request_id, str)
    assert event.result_type == "complete"
    assert event.error_code is None


@pytest.mark.asyncio
async def test_trace_fields_come_from_the_traceparent_in_the_request_meta():
    server, sink = build_server()

    @server.tool()
    def echo(q: str) -> str:
        return q

    async with Client(server) as client:
        await client.call_tool("echo", {"q": "hi"}, meta={"traceparent": TRACEPARENT})
        await client.call_tool("echo", {"q": "hi"}, meta={"traceparent": "nope"})
        await asyncio.sleep(0.05)

    assert sink.events[0].trace_id == "0af7651916cd43dd8448eb211c80319c"
    assert sink.events[0].parent_span_id == "b7ad6b7169203331"
    assert sink.events[1].trace_id is None
    assert sink.events[1].parent_span_id is None


@pytest.mark.asyncio
async def test_tool_hints_come_from_the_annotations_and_are_null_when_undeclared():
    server, sink = build_server()

    @server.tool(annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False))
    def lookup(q: str) -> str:
        return q

    @server.tool()
    def plain(q: str) -> str:
        return q

    # No tools/list first: the hints come from MCPServer.list_tools() on a miss.
    async with Client(server) as client:
        await client.call_tool("lookup", {"q": "hi"})
        await client.call_tool("plain", {"q": "hi"})
        await asyncio.sleep(0.05)

    assert (sink.events[0].read_only_hint, sink.events[0].destructive_hint) == (True, False)
    assert (sink.events[1].read_only_hint, sink.events[1].destructive_hint) == (None, None)


@pytest.mark.asyncio
async def test_an_unknown_tool_is_an_is_error_result_with_no_code():
    # Unlike the TypeScript SDK, MCPServer answers an unknown tool with an
    # isError result rather than a JSON-RPC error, so there is no code.
    server, sink = build_server()

    @server.tool()
    def echo(q: str) -> str:
        return q

    async with Client(server) as client:
        result = await client.call_tool("missing", {})
        await asyncio.sleep(0.05)

    assert result.is_error
    event = sink.events[0]
    assert event.success is False
    assert event.result_type == "complete"
    assert event.error_code is None
    assert (event.read_only_hint, event.destructive_hint) == (None, None)


@pytest.mark.asyncio
async def test_a_json_rpc_error_records_its_code_and_a_null_result_type():
    server, sink = build_server()

    @server.tool()
    def guarded(q: str) -> str:
        raise MCPError.from_error_data(ErrorData(code=-32602, message="bad q"))

    async with Client(server) as client:
        with pytest.raises(MCPError):
            await client.call_tool("guarded", {"q": "hi"})
        await asyncio.sleep(0.05)

    event = sink.events[0]
    assert event.success is False
    assert event.error_code == -32602
    assert event.result_type is None
    assert event.response_bytes == 0


@pytest.mark.asyncio
async def test_2026_07_28_request_fields():
    server, sink = build_server()

    @server.tool()
    def ask(q: str) -> str:
        return q

    app = Starlette(routes=[Mount("/", app=server.streamable_http_app(stateless_http=True))])
    body = {
        "jsonrpc": "2.0",
        "id": "req-7",
        "method": "tools/call",
        "params": {
            "name": "ask",
            "arguments": {"q": "hi"},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
                "traceparent": TRACEPARENT,
            },
        },
    }
    async with server.session_manager.run():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8001"
        ) as client:
            response = await client.post(
                "/mcp",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2026-07-28",
                    "Mcp-Method": "tools/call",
                    "Mcp-Name": "ask",
                },
                content=json.dumps(body),
            )
        await asyncio.sleep(0.05)

    assert response.status_code == 200, response.text
    event = sink.events[0]
    assert event.protocol_version == "2026-07-28"
    assert event.request_id == "req-7"
    assert event.trace_id == "0af7651916cd43dd8448eb211c80319c"
    assert event.result_type == "complete"


def test_parse_traceparent_accepts_valid_headers_and_rejects_everything_else():
    assert parse_traceparent(TRACEPARENT) == (
        "0af7651916cd43dd8448eb211c80319c",
        "b7ad6b7169203331",
    )
    # A future version may append fields.
    assert parse_traceparent("01" + TRACEPARENT[2:] + "-extra")
    for bad in [
        None,
        42,
        "",
        "ff" + TRACEPARENT[2:],
        TRACEPARENT + "-extra",
        "00-00000000000000000000000000000000-b7ad6b7169203331-01",
        "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
        TRACEPARENT.upper(),
        TRACEPARENT + "\n",
    ]:
        assert parse_traceparent(bad) is None, bad


def test_result_type_reads_both_result_shapes():
    assert _result_type({"resultType": "input_required"}) == "input_required"
    assert _result_type({"content": []}) == "complete"
    assert _result_type({"resultType": "complete"}) == "complete"


def test_error_code_is_known_only_for_mcp_and_validation_errors():
    assert _error_code(MCPError.from_error_data(ErrorData(code=-32602, message="x"))) == -32602
    assert _error_code(RuntimeError("boom")) is None


def test_tool_hints_read_the_wire_shape():
    assert _tool_hints({"name": "a", "annotations": {"readOnlyHint": True}}) == ("a", (True, None))
    assert _tool_hints({"name": "b"}) == ("b", (None, None))
    assert _tool_hints({"name": "c", "annotations": {"destructiveHint": "yes"}}) == (
        "c",
        (None, None),
    )
