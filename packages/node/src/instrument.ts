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
  /** Pass `null` for manual mode: no interval timer, no `beforeExit` listener — flush explicitly via the returned handle's `flush()`. */
  flushIntervalMs?: number | null;
}

/**
 * Returned by `instrument()`. `server` is the same instance passed in
 * (instrumentation mutates it in place); use the handle's `server` rather
 * than your own pre-instrument reference so a future non-mutating
 * implementation doesn't silently drop instrumentation under you.
 */
export interface InstrumentHandle {
  server: McpServer;
  /** Flushes any buffered events immediately. On a request-scoped runtime (e.g. Cloudflare Workers), call this via `ctx.waitUntil(handle.flush())` before returning the response. */
  flush(): Promise<void>;
  /**
   * Shuts instrumentation down: a final `flush()`, then the interval timer
   * is cleared and the `beforeExit` listener removed. Call it when the host
   * disposes the server before the process ends - tests, hot reload, one
   * server per connection - so each `instrument()` call releases what it
   * registered. Idempotent. In manual mode (`flushIntervalMs: null`) there
   * is no timer or listener, so it is equivalent to `flush()`.
   */
  close(): Promise<void>;
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
 * Nothing the library does around a tool call can change what the client
 * receives. The real handler always runs, its return value is passed through
 * unchanged, and a thrown error is re-thrown unchanged; this wrapper only
 * observes it. Every library-side step (request/response byte counting,
 * `resolveIdentity`, redaction, event construction, the buffer push) is
 * guarded: a failure is logged once per `instrument()` call via
 * `console.error`, then suppressed, and the step falls back to a neutral
 * value (`request_bytes`/`response_bytes` 0, empty identity, `arguments:
 * null`). A failing redactor therefore records `arguments: null`, never the
 * raw arguments. A failure inside a sink is handled separately by
 * EventBuffer, also logged once per sink.
 */
export function instrument(server: McpServer, options: InstrumentOptions): InstrumentHandle {
  const buffer = new EventBuffer({
    sinks: options.sinks,
    bufferSize: options.bufferSize,
    flushIntervalMs: options.flushIntervalMs
  });

  // Same "log once, then suppress" pattern EventBuffer uses per sink, scoped
  // to this instrument() call: one line is enough to surface a broken
  // resolver or redactor, and a line per tool call would drown the host's logs.
  let telemetryWarned = false;
  const warnOnce = (step: string, error: unknown): void => {
    if (telemetryWarned) return;
    telemetryWarned = true;
    console.error(
      `[mcpsignals] ${step} failed; the tool result is unaffected and further telemetry errors from this instrument() call are suppressed:`,
      error
    );
  };
  /** Runs one library-side step; on a throw, logs once and returns `fallback`. */
  const guarded = <T>(step: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      warnOnce(step, error);
      return fallback;
    }
  };

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

    /**
     * Runs one tool call with telemetry around it. `invoke` receives the args
     * with any injected intent-capture keys stripped and must call the real
     * handler with the arity the SDK would have used for this registration.
     */
    const observeCall = async (
      args: Record<string, unknown>,
      ctx: ToolCallContext,
      invoke: (cleanArgs: Record<string, unknown>) => unknown
    ) => {
      const startedAt = new Date();
      const start = performance.now();

      // `JSON.stringify` throws on a BigInt (and on a throwing `toJSON`);
      // an unmeasurable request is recorded as 0 bytes, never blocks the handler.
      const requestBytes = guarded('request byte count', () => byteLength(args), 0);

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
      // A host resolver that throws or rejects records a null identity; the
      // handler still runs. (#27 covers where this runs relative to the timer.)
      let identity: { userId?: string; orgId?: string } = {};
      try {
        identity = (await options.resolveIdentity?.({ sessionId: ctx.sessionId })) ?? {};
      } catch (error) {
        warnOnce('resolveIdentity', error);
      }

      /**
       * Builds and pushes the event. Every caller wraps this in `guarded`, so
       * a failure anywhere in here (client info, redaction, the buffer push)
       * is logged once and the event is dropped, never surfaced to the client.
       * Redaction is guarded on its own so a broken redactor still leaves an
       * event behind, recorded with `arguments: null` rather than the raw args.
       */
      const push = (
        partial: Pick<ToolCallEvent, 'success' | 'error_kind' | 'error_message' | 'response_bytes'>
      ) => {
        // getClientVersion() is deprecated in favor of reading client identity off the
        // per-request `_meta` envelope, but the SDK's own deprecation note says the accessor
        // "remains functional" and is backfilled per request on 2026-07-28-era connections too.
        // Deliberately kept rather than reaching into the envelope's internal shape, which isn't
        // part of this SDK's stable public surface yet.
        const clientInfo = server.server.getClientVersion();
        const recordedArguments = guarded(
          'redaction',
          () => applyRedaction(cleanArgs, options.redaction, options.captureArguments),
          null
        );
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
          arguments: recordedArguments,
          intent,
          transport: ctx.http ? 'http' : 'stdio',
          ...partial
        });
      };

      // Only the handler call itself lives in this try: a throw here is the
      // handler's own, recorded and re-thrown unchanged. Recording happens
      // outside it so a telemetry failure can never be mistaken for one.
      let result: ToolResultLike;
      try {
        result = (await invoke(cleanArgs)) as ToolResultLike;
      } catch (error) {
        guarded(
          'event recording',
          () => {
            const message = error instanceof Error ? error.message : String(error);
            const truncated = message.length > 2000 ? message.slice(0, 2000) : message;
            push({
              success: false,
              error_kind: classifyError(truncated),
              error_message: truncated,
              response_bytes: 0
            });
          },
          undefined
        );
        throw error;
      }

      guarded(
        'event recording',
        () => {
          const responseBytes = guarded('response byte count', () => byteLength(result), 0);
          if (result?.isError) {
            const errorMessage = extractErrorMessage(result);
            push({
              success: false,
              error_kind: classifyError(errorMessage),
              error_message: errorMessage,
              response_bytes: responseBytes
            });
          } else {
            push({
              success: true,
              error_kind: null,
              error_message: null,
              response_bytes: responseBytes
            });
          }
        },
        undefined
      );
      return result;
    };

    // The SDK's `createToolExecutor` picks the handler arity from the registered
    // `inputSchema` (same truthiness check as here): with a schema it calls
    // `(args, ctx)`; without one it calls `(ctx)` and never forwards the
    // arguments. The wrapper has to match that arity, otherwise the schema-less
    // handler gets the ctx object in `args` and `undefined` in `ctx`. Branch on
    // the final `wrappedConfig.inputSchema`, since intent capture may have
    // injected a schema into a registration that had none.
    //
    // On the schema-less path the SDK does not validate or pass the arguments,
    // so the wrapper records the call as an empty-arguments call (`args = {}`)
    // rather than reaching into the raw request for a payload the handler
    // never sees. `request_bytes` therefore matches a schema-backed tool
    // called with `{}`.
    const wrappedCb = wrappedConfig.inputSchema
      ? async (args: Record<string, unknown>, ctx: ToolCallContext) =>
          observeCall(args, ctx, cleanArgs => cb(cleanArgs, ctx))
      : async (ctx: ToolCallContext) => observeCall({}, ctx, () => cb(ctx));

    // The real `registerTool` overloads are exact per input/output schema shape; a
    // generic wrapper can't preserve that precision through a monkey-patch, so we
    // widen to `any` at this one call site rather than fighting the overload set.
    return (originalRegisterTool as (...args: unknown[]) => unknown)(
      name,
      wrappedConfig,
      wrappedCb
    );
  }) as typeof server.registerTool;

  return {
    server,
    flush: () => buffer.flush(),
    close: async () => {
      try {
        await buffer.flush();
      } finally {
        buffer.stop();
      }
    }
  };
}
