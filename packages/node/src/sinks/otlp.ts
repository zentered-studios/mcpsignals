import type { Sink } from './types.js';
import type { AnyEvent } from '../events.js';

/**
 * The MCP semconv's "Recording MCP transport" table: stdio is `pipe`,
 * streamable HTTP is `tcp` with `network.protocol.name` `http`. The
 * original value also stays on `mcpsignals.transport`.
 */
function networkAttributes(transport: string | null): Record<string, string> {
  if (transport === 'stdio') return { 'network.transport': 'pipe' };
  if (transport === 'http') {
    return { 'network.transport': 'tcp', 'network.protocol.name': 'http' };
  }
  return {};
}

/**
 * Emits one span per `tool_call` event via the global OpenTelemetry
 * TracerProvider — this sink does not manage its own exporter, it relies on
 * whatever the host application already configured (the standard OTel
 * zero-code pattern). Requires the optional peer dependency
 * `@opentelemetry/api` only (not an SDK or exporter). A span is a child of
 * the caller's span when the request carried a `traceparent`, and a root
 * span otherwise. It is never parented to the context active at flush time;
 * see the note at `startSpan`.
 *
 * Attribute mapping verified against the live `open-telemetry/semantic-
 * conventions-genai` repo (docs/gen-ai/mcp.md) as of this writing. Every
 * `gen_ai.*` / `mcp.*` attribute below is marked Development, not Stable —
 * expect these names to still move. Fields with no defined MCP/GenAI
 * convention are emitted as custom `mcpsignals.*` attributes.
 */
export function otlpSink(): Sink {
  return {
    async write(events: AnyEvent[]): Promise<void> {
      const otel = await import('@opentelemetry/api');
      const tracer = otel.trace.getTracer('mcpsignals');

      for (const event of events) {
        if (event.event_type !== 'tool_call') continue;

        // Events are written in batches, usually from inside whatever request
        // handler pushed the last event, so context.active() (the default
        // parent) belongs to an unrelated span. Start from ROOT_CONTEXT, or
        // from the caller's span when the request carried a `traceparent`.
        // The event does not keep the caller's trace flags, so the remote
        // parent is marked sampled and the host's sampler decides.
        const parent =
          event.trace_id !== null && event.parent_span_id !== null
            ? otel.trace.setSpanContext(otel.ROOT_CONTEXT, {
                traceId: event.trace_id,
                spanId: event.parent_span_id,
                traceFlags: otel.TraceFlags.SAMPLED,
                isRemote: true
              })
            : otel.ROOT_CONTEXT;
        const span = tracer.startSpan(
          `tools/call ${event.tool_name}`,
          {
            kind: otel.SpanKind.SERVER,
            startTime: event.ts,
            attributes: {
              'mcp.method.name': 'tools/call',
              'gen_ai.operation.name': 'execute_tool',
              'gen_ai.tool.name': event.tool_name,
              ...networkAttributes(event.transport),
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
              ...(event.error_kind !== null && { 'mcpsignals.error.kind': event.error_kind }),
              ...(event.protocol_version !== null && {
                'mcp.protocol.version': event.protocol_version
              }),
              ...(event.request_id !== null && { 'jsonrpc.request.id': event.request_id }),
              ...(event.result_type !== null && { 'mcpsignals.result.type': event.result_type }),
              ...(event.read_only_hint !== null && {
                'mcpsignals.tool.read_only_hint': event.read_only_hint
              }),
              ...(event.destructive_hint !== null && {
                'mcpsignals.tool.destructive_hint': event.destructive_hint
              })
            }
          },
          parent
        );

        if (!event.success) {
          // A JSON-RPC error's code, else the value the semconv gives an `isError` result.
          if (event.error_code !== null) {
            span.setAttribute('error.type', String(event.error_code));
            span.setAttribute('rpc.response.status_code', String(event.error_code));
          } else {
            span.setAttribute('error.type', 'tool_error');
          }
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
