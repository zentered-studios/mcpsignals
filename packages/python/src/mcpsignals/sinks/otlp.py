"""OTLP sink. Requires the `otlp` extra (opentelemetry-api only, not an SDK
or exporter - relies on whatever global TracerProvider the host app already
configured, the standard "zero-code" OTel pattern). Emits one span per tool
call: a child of the caller's span when the request carried a `traceparent`,
a root span otherwise. Spans are never parented to the context current at
flush time (see the note at `start_span` in `write`).

Field mapping verified against the live OpenTelemetry GenAI semantic
conventions for MCP (open-telemetry/semantic-conventions-genai,
docs/gen-ai/mcp.md) as of this writing. Everything in that document is
Development/Experimental status, not Stable, except where noted below.
Where our schema has no equivalent convention, we use a custom
`mcpsignals.*` attribute rather than force a bad fit.
"""

import json

from mcpsignals.events import ToolCallEvent


def _network_attributes(transport: str | None) -> dict[str, str]:
    """The MCP semconv's "Recording MCP transport" table: stdio is `pipe`,
    streamable HTTP is `tcp` with `network.protocol.name` `http`. The
    original value also stays on `mcpsignals.transport`."""
    if transport == "stdio":
        return {"network.transport": "pipe"}
    if transport == "http":
        return {"network.transport": "tcp", "network.protocol.name": "http"}
    return {}


class OtlpSink:
    def __init__(self, tracer=None):
        if tracer is None:
            from opentelemetry import trace  # local import: don't require the API unless used

            tracer = trace.get_tracer("mcpsignals")
        self._tracer = tracer

    async def write(self, events: list[ToolCallEvent]) -> None:
        from opentelemetry.context import Context
        from opentelemetry.trace import (
            NonRecordingSpan,
            SpanContext,
            SpanKind,
            Status,
            StatusCode,
            TraceFlags,
            set_span_in_context,
        )

        for event in events:
            attributes = {
                "mcp.method.name": "tools/call",
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": event.tool_name,
                **_network_attributes(event.transport),
                "mcpsignals.server.name": event.server_name,
                "mcpsignals.request.bytes": event.request_bytes,
                "mcpsignals.response.bytes": event.response_bytes,
            }
            if event.session_id:
                attributes["mcp.session.id"] = event.session_id
            if event.server_version:
                attributes["mcpsignals.server.version"] = event.server_version
            if event.client_name:
                attributes["mcpsignals.client.name"] = event.client_name
            if event.client_version:
                attributes["mcpsignals.client.version"] = event.client_version
            if event.agent_id:
                attributes["mcpsignals.agent.id"] = event.agent_id
            if event.user_id:
                # enduser.id is Stable in general OTel semconv, but is
                # security-sensitive/opt-in - only set when the host supplied one.
                attributes["enduser.id"] = event.user_id
            if event.org_id:
                attributes["mcpsignals.org.id"] = event.org_id
            if event.transport:
                attributes["mcpsignals.transport"] = event.transport
            if event.intent:
                attributes["mcpsignals.intent"] = event.intent
            if not event.success:
                # A JSON-RPC error's code, else the semconv value for an
                # `isError` tool result. Same as the Node sink.
                if event.error_code is not None:
                    attributes["error.type"] = str(event.error_code)
                    attributes["rpc.response.status_code"] = str(event.error_code)
                else:
                    attributes["error.type"] = "tool_error"
            if event.protocol_version:
                attributes["mcp.protocol.version"] = event.protocol_version
            if event.request_id:
                attributes["jsonrpc.request.id"] = event.request_id
            if event.result_type:
                attributes["mcpsignals.result.type"] = event.result_type
            if event.read_only_hint is not None:
                attributes["mcpsignals.tool.read_only_hint"] = event.read_only_hint
            if event.destructive_hint is not None:
                attributes["mcpsignals.tool.destructive_hint"] = event.destructive_hint
            if event.error_kind:
                attributes["mcpsignals.error.kind"] = event.error_kind
            if event.arguments is not None:
                attributes["gen_ai.tool.call.arguments"] = json.dumps(event.arguments)

            # Events are written in batches, potentially long after the call
            # happened, so the span's start/end must be stamped from the
            # event's own ts/duration_ms rather than "now" - otherwise every
            # span would report the buffer's flush time as its duration.
            start_ns = int(event.ts.timestamp() * 1_000_000_000) if event.ts else None
            end_ns = start_ns + event.duration_ms * 1_000_000 if start_ns is not None else None

            # The batch is usually written from inside whatever request handler
            # pushed the last event, so the current context (the default
            # parent) belongs to an unrelated span. Start from an empty
            # Context, or from the caller's span when the request carried a
            # `traceparent`. The event does not keep the caller's trace flags,
            # so the remote parent is marked sampled and the host's sampler
            # decides.
            parent = Context()
            if event.trace_id and event.parent_span_id:
                parent = set_span_in_context(
                    NonRecordingSpan(
                        SpanContext(
                            trace_id=int(event.trace_id, 16),
                            span_id=int(event.parent_span_id, 16),
                            is_remote=True,
                            trace_flags=TraceFlags(TraceFlags.SAMPLED),
                        )
                    ),
                    parent,
                )
            span = self._tracer.start_span(
                f"tools/call {event.tool_name}",
                context=parent,
                kind=SpanKind.SERVER,
                attributes=attributes,
                start_time=start_ns,
            )
            if event.success:
                span.set_status(Status(StatusCode.OK))
            else:
                span.set_status(Status(StatusCode.ERROR, description=event.error_message))
                if event.error_message:
                    span.record_exception(Exception(event.error_message))
            span.end(end_time=end_ns)
