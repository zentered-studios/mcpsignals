/** Matches schema/events.md. Field names are snake_case to match every sink's wire format. */

/** Every value `error_kind` can take. `classifyError` only produces some of them; see schema/events.md. */
export const ERROR_KINDS = [
  'not_found',
  'empty',
  'validation',
  'auth_required',
  'payment_required',
  'internal'
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * `_meta` key a tool handler sets on an `isError` result to record the
 * `error_kind` it already knows, instead of relying on `classifyError`.
 */
export const ERROR_KIND_META_KEY = 'mcpsignals/error_kind';

export interface ToolCallEvent {
  event_type: 'tool_call';
  ts: Date;
  server_name: string;
  server_version: string | null;
  tool_name: string;
  session_id: string | null;
  agent_id: string | null;
  client_name: string | null;
  client_version: string | null;
  user_id: string | null;
  org_id: string | null;
  duration_ms: number;
  success: boolean;
  error_kind: ErrorKind | null;
  error_message: string | null;
  request_bytes: number;
  response_bytes: number;
  arguments: Record<string, unknown> | null;
  intent: string | null;
  transport: string | null;
}

/**
 * What a sink receives. There is one event type today, so this is an alias
 * for `ToolCallEvent` rather than a union - it stays as the name sinks are
 * written against, and as the seam a second event type would widen. Keep
 * discriminating on `event_type` in sinks for the same reason.
 */
export type AnyEvent = ToolCallEvent;
