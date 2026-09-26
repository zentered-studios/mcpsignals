import type { McpServer } from '@modelcontextprotocol/server';
import type { Sink } from './sinks/types.js';
import { ERROR_KIND_META_KEY, type ToolCallEvent } from './events.js';
import { parseTraceparent } from './trace-context.js';
import { classifyError, isErrorKind } from './error-kind.js';
import { applyRedaction, type RedactionConfig } from './redaction.js';
import {
  extractAndStripIntent,
  injectIntentSchema,
  isIntentCaptureEnabled,
  schemaSupportsInjection,
  type IntentCaptureOption
} from './intent-capture.js';
import { EventBuffer } from './buffer.js';
import { boundedString, MAX_IDENTIFIER_LENGTH } from './bounded.js';

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
  mcpReq?: {
    id?: unknown;
    /** The request `_meta`, with the reserved `io.modelcontextprotocol/*` keys lifted into `envelope`. */
    _meta?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
  };
}

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  resultType?: unknown;
  _meta?: Record<string, unknown>;
}

/** The part of McpServer's `RegisteredTool` this file uses. Its `annotations` change on `update()`. */
interface RegisteredToolLike {
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
  update?: (updates: { name?: unknown }) => unknown;
}

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';

/** JSON-RPC's code for an error with no code of its own, as the SDK answers it. */
const INTERNAL_ERROR_CODE = -32603;

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

interface ToolsCallRequest {
  params?: { name?: unknown; arguments?: unknown };
}

type ToolsCallHandler = (request: ToolsCallRequest, ctx: ToolCallContext) => unknown;

/** The intent-capture values a call carried, and its arguments without them. */
type IntentFields = ReturnType<typeof extractAndStripIntent>;

function noIntentFields(args: Record<string, unknown>): IntentFields {
  return { clean: args, session_id: null, agent_id: null, intent: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// TextEncoder rather than Buffer.byteLength: this runs on every tool call,
// and Buffer only exists on Cloudflare Workers behind the nodejs_compat flag.
const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? '').length;
}

/**
 * Proves the recorded arguments survive JSON encoding, or throws.
 *
 * Every sink re-serializes `arguments` on its way out - `JSON.stringify` in
 * console/d1/bigquery, `pg`'s own jsonb encoder in postgres - and a value
 * that cannot be encoded makes that whole `write()` throw. EventBuffer
 * catches the throw, so the server is never affected, but the entire batch
 * is dropped with it, including the unrelated events flushed alongside.
 * Checking here means one bad value costs one event's `arguments`, never a
 * whole flush.
 *
 * Only a `redaction.redactor` or a `redaction.allow` entry can produce such
 * a value: the default type-only markers are always encodable. The extra
 * `JSON.stringify` therefore runs only when argument capture is on, and not
 * at all on the default path, where `value` is null.
 */
function assertSerializable(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (value === null) return null;
  JSON.stringify(value); // throws on a BigInt, a circular reference, or a throwing toJSON
  return value;
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
 * any tools, since it works by wrapping `registerTool` and the `tools/call`
 * handler McpServer installs on its first registration.
 *
 * Every `tools/call` the server answers is recorded, including ones that
 * never reach a tool callback: an unknown or disabled tool, and arguments
 * that fail the tool's `inputSchema`. `success` follows the result the
 * client receives, so a result McpServer rejects against `outputSchema` is
 * recorded as failed.
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
  /** `guarded` for an async step: a throw or a rejection logs once and yields `fallback`. */
  const guardedAsync = async <T>(step: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      warnOnce(step, error);
      return fallback;
    }
  };

  /**
   * What the tool callback saw, handed from the `registerTool` wrapper to the
   * `tools/call` recorder below. Keyed by the request's `ctx`: McpServer
   * passes its `tools/call` handler's `ctx` straight through to the tool
   * callback, so both layers see the same object.
   */
  const handlerCalls = new WeakMap<object, IntentFields>();
  /** Registered tool name -> whether intent capture injected its schema, and the SDK's tool object. */
  const registeredTools = new Map<string, { canInject: boolean; tool?: RegisteredToolLike }>();

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

    /** Strips injected intent-capture keys and leaves them for the recorder. */
    const prepare = (args: Record<string, unknown>, ctx: ToolCallContext) => {
      const fields = canInject ? extractAndStripIntent(args) : noIntentFields(args);
      handlerCalls.set(ctx, fields);
      return fields.clean;
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
    // so `arguments` is recorded as an empty-arguments call (`{}`) rather than
    // a payload the handler never sees.
    const wrappedCb = wrappedConfig.inputSchema
      ? async (args: Record<string, unknown>, ctx: ToolCallContext) => cb(prepare(args, ctx), ctx)
      : async (ctx: ToolCallContext) => {
          prepare({}, ctx);
          return cb(ctx);
        };

    // The real `registerTool` overloads are exact per input/output schema shape; a
    // generic wrapper can't preserve that precision through a monkey-patch, so we
    // widen to `any` at this one call site rather than fighting the overload set.
    const tool = (originalRegisterTool as (...args: unknown[]) => unknown)(
      name,
      wrappedConfig,
      wrappedCb
    ) as RegisteredToolLike;
    // Only after the SDK accepted it: a duplicate name throws above and must
    // not replace the first registration. `tool` is read at call time, not
    // now, so `RegisteredTool.update({ annotations })` is honored.
    const registration = { canInject, tool };
    registeredTools.set(name, registration);

    // Follow `update({ name })` the way the SDK does: a new name moves the
    // registration, a null or empty one removes it. `remove()` goes through
    // `update`, so this covers it too.
    let currentName = name;
    const originalUpdate = tool.update;
    if (typeof originalUpdate === 'function') {
      tool.update = (updates: { name?: unknown }) => {
        const result = originalUpdate(updates);
        if (updates?.name !== undefined && updates.name !== currentName) {
          if (registeredTools.get(currentName) === registration) {
            registeredTools.delete(currentName);
          }
          if (typeof updates.name === 'string' && updates.name) {
            registeredTools.set(updates.name, registration);
            currentName = updates.name;
          }
        }
        return result;
      };
    }
    return tool;
  }) as typeof server.registerTool;

  /**
   * Runs one `tools/call` request with telemetry around it. This wraps the
   * handler McpServer registers, not the tool callback, so it sees what the
   * client sees: an unknown or disabled tool (a JSON-RPC error), an
   * input-schema failure (an `isError` result, callback never runs), and an
   * output-schema failure (an `isError` result, callback already returned
   * success). A tool callback that throws reaches this layer as McpServer's
   * `isError` result carrying the error message.
   */
  const observeToolsCall = async (
    request: ToolsCallRequest,
    ctx: ToolCallContext,
    handler: ToolsCallHandler
  ) => {
    const startedAt = new Date();
    const start = performance.now();

    const params = request?.params ?? {};
    const rawName = typeof params.name === 'string' ? params.name : '';
    const rawArgs = params.arguments ?? {};
    // `JSON.stringify` throws on a BigInt (and on a throwing `toJSON`);
    // an unmeasurable request is recorded as 0 bytes, never blocks the handler.
    const requestBytes = guarded('request byte count', () => byteLength(rawArgs), 0);

    /**
     * Builds and pushes the event. Every caller wraps this in `guardedAsync`,
     * so a failure anywhere in here (identity, client info, redaction, the
     * buffer push) is logged once and the event is dropped, never surfaced
     * to the client. Redaction and `resolveIdentity` are guarded on their
     * own so a broken redactor or resolver still leaves an event behind,
     * recorded with `arguments: null` / a null identity.
     *
     * `durationMs` is measured by the caller the moment the handler settles.
     * `resolveIdentity` runs in here, after the handler, so its latency is
     * outside the timed window: `duration_ms` is wall time from call start
     * to response, per schema/events.md.
     */
    const push = async (
      durationMs: number,
      partial: Pick<
        ToolCallEvent,
        'success' | 'error_kind' | 'error_message' | 'response_bytes' | 'result_type' | 'error_code'
      >
    ) => {
      const registration = registeredTools.get(rawName);
      // The callback's view when it ran. When it never ran, read the raw
      // arguments the way it would have, so a rejected call still records intent.
      const rawRecord = isRecord(rawArgs) ? rawArgs : {};
      const fields =
        handlerCalls.get(ctx) ??
        (registration?.canInject ? extractAndStripIntent(rawRecord) : noIntentFields(rawRecord));

      // Revision 2026-07-28 carries the version on every request's envelope;
      // earlier revisions negotiate it once in `initialize`. Either way the
      // client supplied it, so it takes the identifier cap. The accessor is
      // deprecated for the same reason as getClientVersion() below and is
      // only the fallback for a request with no envelope.
      const protocolVersion = boundedString(
        ctx.mcpReq?.envelope?.[PROTOCOL_VERSION_META_KEY] ??
          server.server.getNegotiatedProtocolVersion(),
        MAX_IDENTIFIER_LENGTH
      );
      const requestId = ctx.mcpReq?.id;
      // `_meta` is the MCP protocol's field name.
      // oxlint-disable-next-line no-underscore-dangle
      const trace = parseTraceparent(ctx.mcpReq?._meta?.traceparent);
      const annotations = registration?.tool?.annotations;

      // A host resolver that throws or rejects records a null identity.
      let identity: { userId?: string; orgId?: string } = {};
      try {
        identity = (await options.resolveIdentity?.({ sessionId: ctx.sessionId })) ?? {};
      } catch (error) {
        warnOnce('resolveIdentity', error);
      }
      // getClientVersion() is deprecated in favor of reading client identity off the
      // per-request `_meta` envelope, but the SDK's own deprecation note says the accessor
      // "remains functional" and is backfilled per request on 2026-07-28-era connections too.
      // Deliberately kept rather than reaching into the envelope's internal shape, which isn't
      // part of this SDK's stable public surface yet.
      //
      // The client declares its own name/version in the `initialize` handshake, so
      // both are caller-controlled and take the same identifier cap as the intent
      // fields (see bounded.ts).
      const clientInfo = server.server.getClientVersion();
      const clientName = boundedString(clientInfo?.name, MAX_IDENTIFIER_LENGTH);
      const clientVersion = boundedString(clientInfo?.version, MAX_IDENTIFIER_LENGTH);
      const recordedArguments = guarded(
        'redaction',
        () =>
          assertSerializable(
            applyRedaction(fields.clean, options.redaction, options.captureArguments)
          ),
        null
      );
      buffer.push({
        event_type: 'tool_call',
        ts: startedAt,
        server_name: options.serverName,
        server_version: options.serverVersion ?? null,
        // A registered name is the server's own. Any other name came from the
        // client, so it takes the identifier cap.
        tool_name: registeredTools.has(rawName)
          ? rawName
          : (boundedString(rawName, MAX_IDENTIFIER_LENGTH) ?? ''),
        session_id: ctx.sessionId ?? fields.session_id,
        agent_id: fields.agent_id,
        client_name: clientName,
        client_version: clientVersion,
        user_id: identity.userId ?? null,
        org_id: identity.orgId ?? null,
        duration_ms: durationMs,
        request_bytes: requestBytes,
        arguments: recordedArguments,
        intent: fields.intent,
        transport: ctx.http ? 'http' : 'stdio',
        protocol_version: protocolVersion,
        request_id:
          typeof requestId === 'string' || typeof requestId === 'number'
            ? boundedString(String(requestId), MAX_IDENTIFIER_LENGTH)
            : null,
        trace_id: trace?.traceId ?? null,
        parent_span_id: trace?.parentSpanId ?? null,
        read_only_hint: booleanOrNull(annotations?.readOnlyHint),
        destructive_hint: booleanOrNull(annotations?.destructiveHint),
        ...partial
      });
    };

    // Only the handler call itself lives in this try: a throw here is a
    // protocol error the client receives as a JSON-RPC error, recorded and
    // re-thrown unchanged. Recording happens outside it so a telemetry
    // failure can never be mistaken for one.
    let result: ToolResultLike;
    try {
      result = (await handler(request, ctx)) as ToolResultLike;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      await guardedAsync(
        'event recording',
        async () => {
          const message = error instanceof Error ? error.message : String(error);
          const truncated = message.length > 2000 ? message.slice(0, 2000) : message;
          // The same rule the SDK uses to answer: the error's own integer
          // `code` (a ProtocolError's), otherwise internal error.
          const code = (error as { code?: unknown } | null)?.code;
          await push(durationMs, {
            success: false,
            error_kind: classifyError(truncated),
            error_message: truncated,
            response_bytes: 0,
            result_type: null,
            error_code: Number.isSafeInteger(code) ? (code as number) : INTERNAL_ERROR_CODE
          });
        },
        undefined
      );
      throw error;
    }

    const durationMs = Math.round(performance.now() - start);
    await guardedAsync(
      'event recording',
      async () => {
        const responseBytes = guarded('response byte count', () => byteLength(result), 0);
        // Absent means complete: the SDK stamps `resultType` after this layer.
        const resultType = result?.resultType === 'input_required' ? 'input_required' : 'complete';
        if (result?.isError) {
          const errorMessage = extractErrorMessage(result);
          // A kind the handler declared wins; an unknown value falls back to the heuristic.
          // Guarded on its own so a throwing `_meta` costs only the declared kind, not the event.
          const declaredKind = guarded(
            'declared error kind',
            // `_meta` is the MCP protocol's field name.
            // oxlint-disable-next-line no-underscore-dangle
            () => result._meta?.[ERROR_KIND_META_KEY],
            undefined
          );
          await push(durationMs, {
            success: false,
            error_kind: isErrorKind(declaredKind) ? declaredKind : classifyError(errorMessage),
            error_message: errorMessage,
            response_bytes: responseBytes,
            result_type: resultType,
            error_code: null
          });
        } else {
          await push(durationMs, {
            success: true,
            error_kind: null,
            error_message: null,
            response_bytes: responseBytes,
            result_type: resultType,
            error_code: null
          });
        }
      },
      undefined
    );
    return result;
  };

  // McpServer installs its `tools/call` handler through the public
  // `Server.setRequestHandler` the first time a tool is registered, which is
  // after this call. Wrap that one registration; every other method passes
  // through untouched.
  const lowLevel = server.server;
  const originalSetRequestHandler = lowLevel.setRequestHandler.bind(lowLevel) as (
    ...args: unknown[]
  ) => unknown;
  lowLevel.setRequestHandler = ((method: unknown, ...rest: unknown[]) => {
    const [handler] = rest;
    if (method !== 'tools/call' || rest.length !== 1 || typeof handler !== 'function') {
      return originalSetRequestHandler(method, ...rest);
    }
    return originalSetRequestHandler(method, (request: ToolsCallRequest, ctx: ToolCallContext) =>
      observeToolsCall(request, ctx, handler as ToolsCallHandler)
    );
  }) as typeof lowLevel.setRequestHandler;

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
