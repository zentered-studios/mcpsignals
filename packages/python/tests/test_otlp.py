from datetime import datetime, timezone

import pytest
from mcpsignals.events import ToolCallEvent
from mcpsignals.sinks.otlp import OtlpSink
from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, SpanKind, TraceFlags


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


def make_event(tool_name: str, duration_ms: int) -> ToolCallEvent:
    return ToolCallEvent(
        ts=datetime(2026, 9, 1, 23, 25, 24, tzinfo=timezone.utc),
        server_name="s",
        tool_name=tool_name,
        duration_ms=duration_ms,
    )


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
