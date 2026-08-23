import type { Sink } from './types.js';
import type { AnyEvent } from '../events.js';

/**
 * Emits one span per `tool_call` event via the global OpenTelemetry
 * TracerProvider — this sink does not manage its own exporter, it relies on
 * whatever the host application already configured (the standard OTel
 * zero-code pattern). Requires the optional peer dependency
 * `@opentelemetry/api` only (not an SDK or exporter).
 *
 * Attribute mapping verified against the live `open-telemetry/semantic-
 * conventions-genai` repo (docs/gen-ai/mcp.md) as of this writing. Every
 * `gen_ai.*` / `mcp.*` attribute below is marked Development, not Stable —
 * expect these names to still move. Fields with no defined MCP/GenAI
 * convention are emitted as custom `mcpsignals.*` attributes rather than
 * forced into a semantically mismatched Stable attribute (see schema/
 * events.md's OTLP mapping note for the `transport` case specifically).
 * `session_summary` events have no span shape defined by the convention and
 * are not emitted by this sink.
 */
export function otlpSink(): Sink {
  return {
    async write(events: AnyEvent[]): Promise<void> {
      const otel = await import('@opentelemetry/api');
      const tracer = otel.trace.getTracer('mcpsignals');

      for (const event of events) {
        if (event.event_type !== 'tool_call') continue;

        const span = tracer.startSpan(`tools/call ${event.tool_name}`, {
          kind: otel.SpanKind.SERVER,
          startTime: event.ts,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': event.tool_name,
            ...(event.session_id !== null && { 'mcp.session.id': event.session_id }),
            ...(event.arguments !== null && {
              'gen_ai.tool.call.arguments': JSON.stringify(event.arguments)
            }),
            ...(event.intent !== null && { 'mcpsignals.intent': event.intent }),
            ...(event.agent_id !== null && { 'mcpsignals.agent.id': event.agent_id }),
            ...(event.user_id !== null && { 'enduser.id': event.user_id }),
            ...(event.org_id !== null && { 'mcpsignals.org.id': event.org_id }),
            'mcpsignals.server.name': event.server_name,
            ...(event.server_version !== null && {
              'mcpsignals.server.version': event.server_version
            }),
            ...(event.client_name !== null && { 'mcpsignals.client.name': event.client_name }),
            ...(event.client_version !== null && {
              'mcpsignals.client.version': event.client_version
            }),
            ...(event.transport !== null && { 'mcpsignals.transport': event.transport }),
            'mcpsignals.request.bytes': event.request_bytes,
            'mcpsignals.response.bytes': event.response_bytes,
            ...(event.error_kind !== null && { 'mcpsignals.error.kind': event.error_kind })
          }
        });

        if (!event.success) {
          span.setAttribute('error.type', 'tool_error');
          span.setStatus({
            code: otel.SpanStatusCode.ERROR,
            message: event.error_message ?? undefined
          });
          if (event.error_message) {
            span.addEvent('exception', { 'exception.message': event.error_message });
          }
        } else {
          span.setStatus({ code: otel.SpanStatusCode.OK });
        }

        const endTime = new Date(event.ts.getTime() + event.duration_ms);
        span.end(endTime);
      }
    }
  };
}
