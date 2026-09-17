"""OTLP sink. Requires the `otlp` extra (opentelemetry-api only, not an SDK
or exporter - relies on whatever global TracerProvider the host app already
configured, the standard "zero-code" OTel pattern). Emits one root span per
tool call; spans are never parented to the context current at flush time
(see the note at `start_span` in `write`).

Field mapping verified against the live OpenTelemetry GenAI semantic
conventions for MCP (open-telemetry/semantic-conventions-genai,
docs/gen-ai/mcp.md) as of this writing. Everything in that document is
Development/Experimental status, not Stable, except where noted below.
Where our schema has no equivalent convention, we use a custom
`mcpsignals.*` attribute rather than force a bad fit (see `transport`).
"""

import json

from mcpsignals.events import ToolCallEvent


class OtlpSink:
    def __init__(self, tracer=None):
        if tracer is None:
            from opentelemetry import trace  # local import: don't require the API unless used

            tracer = trace.get_tracer("mcpsignals")
        self._tracer = tracer

    async def write(self, events: list[ToolCallEvent]) -> None:
        from opentelemetry.context import Context
        from opentelemetry.trace import SpanKind, Status, StatusCode

        for event in events:
            attributes = {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": event.tool_name,
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
                # Deliberately NOT network.transport: that attribute's vocabulary
                # (tcp/udp/quic/pipe/unix) does not fit MCP's stdio/http.
                attributes["mcpsignals.transport"] = event.transport
            if event.intent:
                attributes["mcpsignals.intent"] = event.intent
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
            # Context so every tool call is its own root span.
            span = self._tracer.start_span(
                f"tools/call {event.tool_name}",
                context=Context(),
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
