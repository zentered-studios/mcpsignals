/** Matches schema/events.md. Field names are snake_case to match every sink's wire format. */

export type ErrorKind = 'not_found' | 'empty' | 'validation' | 'internal';

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

export interface SessionSummaryEvent {
  event_type: 'session_summary';
  ts: Date;
  session_id: string;
  server_name: string;
  server_version: string | null;
  user_id: string | null;
  org_id: string | null;
  call_count: number;
  distinct_tools_used: number;
  wall_duration_ms: number;
  error_count: number;
}

export type AnyEvent = ToolCallEvent | SessionSummaryEvent;
