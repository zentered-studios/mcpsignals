from datetime import datetime, timezone

import pytest
from mcpsignals.events import ToolCallEvent
from mcpsignals.sinks.otlp import OtlpSink
from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.trace import (
    NonRecordingSpan,
    SpanContext,
    SpanKind,
    StatusCode,
    TraceFlags,
)


class RecordingSpan:
    def __init__(self, record: dict):
        self.record = record

    def set_status(self, status):
        self.record["status"] = status

    def record_exception(self, exc):
        self.record["exception"] = exc

    def end(self, end_time=None):
        self.record["end_time"] = end_time


class RecordingTracer:
    """Records every start_span call. Mirrors the API contract the sink relies
    on: Tracer.start_span(name, context=None, ...) falls back to the current
    context when none is passed, which is how an ambient parent leaks in."""

    def __init__(self):
        self.spans: list[dict] = []

    def start_span(self, name, context=None, kind=None, attributes=None, start_time=None, **_):
        record = {
            "name": name,
            "context": context if context is not None else otel_context.get_current(),
            "kind": kind,
            "attributes": attributes,
            "start_time": start_time,
        }
        self.spans.append(record)
        return RecordingSpan(record)


def make_event(tool_name: str = "my-tool", duration_ms: int = 5, **overrides) -> ToolCallEvent:
    defaults = dict(
        ts=datetime(2026, 9, 1, 23, 25, 24, tzinfo=timezone.utc),
        server_name="s",
        tool_name=tool_name,
        duration_ms=duration_ms,
    )
    defaults.update(overrides)
    return ToolCallEvent(**defaults)


async def span_for(event: ToolCallEvent) -> dict:
    tracer = RecordingTracer()
    await OtlpSink(tracer=tracer).write([event])
    return tracer.spans[0]


@pytest.mark.asyncio
async def test_each_tool_call_span_starts_from_root_context():
    tracer = RecordingTracer()
    sink = OtlpSink(tracer=tracer)
    parent = NonRecordingSpan(
        SpanContext(
            trace_id=0x0AF7651916CD43DD8448EB211C80319C,
            span_id=0xB7AD6B7169203331,
            is_remote=False,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        )
    )
    events = [make_event("first", 5), make_event("second", 7)]

    # Simulates the size-triggered flush that runs inside a request handler
    # whose HTTP span is the current span.
    token = otel_context.attach(trace.set_span_in_context(parent))
    try:
        await sink.write(events)
    finally:
        otel_context.detach(token)

    assert len(tracer.spans) == 2
    for event, span in zip(events, tracer.spans, strict=True):
        assert span["name"] == f"tools/call {event.tool_name}"
        assert trace.get_current_span(span["context"]) is trace.INVALID_SPAN, (
            f"span {span['name']} inherited the ambient parent span"
        )
        assert span["kind"] == SpanKind.SERVER
        start_ns = int(event.ts.timestamp() * 1_000_000_000)
        assert span["start_time"] == start_ns
        assert span["end_time"] == start_ns + event.duration_ms * 1_000_000


# The attribute mapping is the sink's whole product, and every `gen_ai.*` /
# `mcp.*` name below is Development status in the OTel GenAI semantic
# conventions, so it moves. These tests pin what we emit today; a convention
# change should make them fail loudly rather than drift silently. They also
# hold the mapping level with the Node sink's, which has the same test.


@pytest.mark.asyncio
async def test_a_fully_populated_event_maps_to_the_documented_attribute_set():
    span = await span_for(
        make_event(
            tool_name="search",
            server_name="my-server",
            server_version="1.2.3",
            session_id="sess-1",
            agent_id="agent-1",
            client_name="my-client",
            client_version="9.9",
            user_id="user-1",
            org_id="org-1",
            transport="http",
            intent="user asked",
            arguments={"a": 1},
            request_bytes=11,
            response_bytes=22,
        )
    )

    assert span["attributes"] == {
        "mcp.method.name": "tools/call",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "search",
        "network.transport": "tcp",
        "network.protocol.name": "http",
        "mcpsignals.server.name": "my-server",
        "mcpsignals.request.bytes": 11,
        "mcpsignals.response.bytes": 22,
        "mcp.session.id": "sess-1",
        "mcpsignals.server.version": "1.2.3",
        "mcpsignals.client.name": "my-client",
        "mcpsignals.client.version": "9.9",
        "mcpsignals.agent.id": "agent-1",
        "enduser.id": "user-1",
        "mcpsignals.org.id": "org-1",
        "mcpsignals.transport": "http",
        "mcpsignals.intent": "user asked",
        "gen_ai.tool.call.arguments": '{"a": 1}',
    }


@pytest.mark.asyncio
async def test_none_fields_are_omitted_rather_than_emitted_as_none_attributes():
    # A None attribute value is not valid in OTel and an exporter may drop the
    # whole span over one. The default event has None everywhere optional.
    span = await span_for(make_event())

    assert sorted(span["attributes"]) == [
        "gen_ai.operation.name",
        "gen_ai.tool.name",
        "mcp.method.name",
        "mcpsignals.request.bytes",
        "mcpsignals.response.bytes",
        "mcpsignals.server.name",
    ]
    assert all(value is not None for value in span["attributes"].values())


@pytest.mark.asyncio
async def test_stdio_maps_to_network_transport_pipe_without_a_protocol_name():
    span = await span_for(make_event(transport="stdio"))

    assert span["attributes"]["network.transport"] == "pipe"
    assert "network.protocol.name" not in span["attributes"]
    assert span["attributes"]["mcpsignals.transport"] == "stdio"


@pytest.mark.asyncio
async def test_a_successful_call_gets_status_ok_and_no_exception():
    span = await span_for(make_event(success=True))

    assert span["status"].status_code is StatusCode.OK
    assert "exception" not in span
    assert "error.type" not in span["attributes"]


@pytest.mark.asyncio
async def test_a_failed_call_gets_status_error_and_records_an_exception():
    span = await span_for(
        make_event(
            success=False,
            error_kind="not_found",
            error_message="record with that id was not found",
        )
    )

    assert span["status"].status_code is StatusCode.ERROR
    assert span["status"].description == "record with that id was not found"
    assert span["attributes"]["error.type"] == "tool_error"
    assert span["attributes"]["mcpsignals.error.kind"] == "not_found"
    assert str(span["exception"]) == "record with that id was not found"


@pytest.mark.asyncio
async def test_a_failure_with_no_message_records_no_exception():
    span = await span_for(make_event(success=False, error_kind=None, error_message=None))

    assert span["status"].status_code is StatusCode.ERROR
    assert "exception" not in span, "no message means nothing to record as an exception"


@pytest.mark.asyncio
async def test_span_start_and_end_come_from_the_event_not_from_flush_time():
    # Events are written in batches, potentially long after the call happened.
    span = await span_for(make_event(duration_ms=1234))

    start_ns = int(
        datetime(2026, 9, 1, 23, 25, 24, tzinfo=timezone.utc).timestamp() * 1_000_000_000
    )
    assert span["start_time"] == start_ns
    assert span["end_time"] == start_ns + 1234 * 1_000_000
