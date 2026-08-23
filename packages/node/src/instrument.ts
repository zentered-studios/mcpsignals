import type { McpServer } from '@modelcontextprotocol/server';
import type { Sink } from './sinks/types.js';
import type { ToolCallEvent } from './events.js';
import { classifyError } from './error-kind.js';
import { applyRedaction, type RedactionConfig } from './redaction.js';
import {
  extractAndStripIntent,
  injectIntentSchema,
  isIntentCaptureEnabled,
  schemaSupportsInjection,
  type IntentCaptureOption
} from './intent-capture.js';
import { EventBuffer } from './buffer.js';

export interface InstrumentOptions {
  /** Required: this server's logical name. Not derivable from the McpServer instance (its `serverInfo` is private), so it's an explicit option. */
  serverName: string;
  serverVersion?: string;
  sinks: Sink[];
  /** Opt-in: capture tool arguments at all. Default false — no arguments are ever recorded unless this is true. */
  captureArguments?: boolean;
  redaction?: RedactionConfig;
  /** Opt-in: inject session_id/agent_id/intent into advertised tool schemas. Default false (off for every tool). */
  intentCapture?: IntentCaptureOption;
  /** Host-supplied user/org identity. The library never infers these itself. */
  resolveIdentity?: (ctx: {
    sessionId?: string;
  }) =>
    | { userId?: string; orgId?: string }
    | undefined
    | Promise<{ userId?: string; orgId?: string } | undefined>;
  bufferSize?: number;
  flushIntervalMs?: number;
}

interface ToolCallContext {
  sessionId?: string;
  http?: unknown;
}

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

function extractErrorMessage(result: ToolResultLike): string | null {
  const text = (result.content ?? [])
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string'
    )
    .map(block => block.text)
    .join(' ');
  if (!text) return null;
  return text.length > 2000 ? text.slice(0, 2000) : text;
}

/**
 * Wraps an `McpServer` so every tool registered through it (after this call)
 * records a `tool_call` event. This is the library's one required call —
 * call it immediately after constructing the server and before registering
 * any tools, since it works by wrapping `registerTool` itself.
 *
 * A failure inside a sink or the buffer is caught and never propagates to
 * the tool handler or delays its response — see EventBuffer. A thrown error
 * from the real tool handler is re-thrown unchanged; this wrapper only
 * observes it.
 */
export function instrument(server: McpServer, options: InstrumentOptions): McpServer {
  const buffer = new EventBuffer({
    sinks: options.sinks,
    bufferSize: options.bufferSize,
    flushIntervalMs: options.flushIntervalMs
  });

  const originalRegisterTool = server.registerTool.bind(server);

  server.registerTool = ((
    name: string,
    config: Record<string, unknown>,
    cb: (...args: unknown[]) => unknown
  ) => {
    const intentEnabled = isIntentCaptureEnabled(options.intentCapture, name);
    const originalInputSchema = config.inputSchema;
    const canInject = intentEnabled && schemaSupportsInjection(originalInputSchema);

    const wrappedConfig = canInject
      ? { ...config, inputSchema: injectIntentSchema(originalInputSchema) }
      : config;

    const wrappedCb = async (args: Record<string, unknown>, ctx: ToolCallContext) => {
      const startedAt = new Date();
      const start = performance.now();

      const requestBytes = byteLength(args);

      let cleanArgs = args;
      let sessionIdFromArgs: string | null = null;
      let agentId: string | null = null;
      let intent: string | null = null;
      if (canInject) {
        const extracted = extractAndStripIntent(args);
        cleanArgs = extracted.clean;
        sessionIdFromArgs = extracted.session_id;
        agentId = extracted.agent_id;
        intent = extracted.intent;
      }

      const sessionId = ctx.sessionId ?? sessionIdFromArgs ?? null;
      const identity = (await options.resolveIdentity?.({ sessionId: ctx.sessionId })) ?? {};
      // getClientVersion() is deprecated in favor of reading client identity off the
      // per-request `_meta` envelope, but the SDK's own deprecation note says the accessor
      // "remains functional" and is backfilled per request on 2026-07-28-era connections too.
      // Deliberately kept rather than reaching into the envelope's internal shape, which isn't
      // part of this SDK's stable public surface yet.
      const clientInfo = server.server.getClientVersion();

      const emit = (
        partial: Pick<ToolCallEvent, 'success' | 'error_kind' | 'error_message' | 'response_bytes'>
      ) => {
        buffer.push({
          event_type: 'tool_call',
          ts: startedAt,
          server_name: options.serverName,
          server_version: options.serverVersion ?? null,
          tool_name: name,
          session_id: sessionId,
          agent_id: agentId,
          client_name: clientInfo?.name ?? null,
          client_version: clientInfo?.version ?? null,
          user_id: identity.userId ?? null,
          org_id: identity.orgId ?? null,
          duration_ms: Math.round(performance.now() - start),
          request_bytes: requestBytes,
          arguments: applyRedaction(cleanArgs, options.redaction, options.captureArguments),
          intent,
          transport: ctx.http ? 'http' : 'stdio',
          ...partial
        });
      };

      try {
        const result = (await cb(cleanArgs, ctx)) as ToolResultLike;
        if (result?.isError) {
          const errorMessage = extractErrorMessage(result);
          emit({
            success: false,
            error_kind: classifyError(errorMessage),
            error_message: errorMessage,
            response_bytes: byteLength(result)
          });
        } else {
          emit({
            success: true,
            error_kind: null,
            error_message: null,
            response_bytes: byteLength(result)
          });
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const truncated = message.length > 2000 ? message.slice(0, 2000) : message;
        emit({
          success: false,
          error_kind: classifyError(truncated),
          error_message: truncated,
          response_bytes: 0
        });
        throw error;
      }
    };

    // The real `registerTool` overloads are exact per input/output schema shape; a
    // generic wrapper can't preserve that precision through a monkey-patch, so we
    // widen to `any` at this one call site rather than fighting the overload set.
    return (originalRegisterTool as (...args: unknown[]) => unknown)(
      name,
      wrappedConfig,
      wrappedCb
    );
  }) as typeof server.registerTool;

  return server;
}
