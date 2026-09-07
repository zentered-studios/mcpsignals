import type { Sink } from './types.js';
import type { AnyEvent } from '../events.js';

export interface D1SinkOptions {
  toolCallTable?: string;
  sessionSummaryTable?: string;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

// developers.cloudflare.com/d1/platform/limits/: "Maximum string, BLOB or
// table row size: 2,000,000 bytes," and that limit applies per statement
// inside a batch(), same as everywhere else. `arguments` is the only field
// in schema/events.md without its own cap (error_message and intent are
// truncated to 2000 chars upstream), so it's the only column that can push
// a row anywhere near that ceiling. Capped well under it to leave headroom
// for the row's other columns.
const MAX_ARGUMENTS_BYTES = 1_000_000;

const encoder = new TextEncoder();

/**
 * Writes rows into the tables defined by schema/events.md's D1 DDL, via a
 * `D1Database` binding (Cloudflare Workers Worker Bindings API). Requires
 * `flushIntervalMs: null` (manual mode) on the buffer/instrument side, same
 * as any sink used from a request-scoped Workers runtime - see the Node
 * README's "Request-scoped runtimes" section.
 *
 * `db.batch()` is a SQL transaction: per the D1 docs, if one statement in
 * the batch fails, D1 aborts and rolls back the entire sequence, not just
 * that statement. An oversized `arguments` payload is therefore not left in
 * the batch to fail it - it's dropped (written as `null`) before binding,
 * with a warning logged at most once per sink instance.
 *
 * `ts` is written as an integer (Unix epoch milliseconds), not a string or
 * `Date`. SQLite's `datetime()` output (`"2026-09-01 23:25:24"`) does not
 * compare correctly against `Date#toISOString()` (`"2026-09-01T23:25:24.000Z"`)
 * - at index 10 `T` sorts above the space, so a `ts >= datetime('now', '-N
 * days')` filter silently includes the whole cutoff day. Read `ts` back out
 * with `unixepoch()` / `datetime(ts / 1000, 'unixepoch')`, not `datetime()`
 * on the raw column.
 */
export function d1Sink(db: D1Database, options: D1SinkOptions = {}): Sink {
  const toolCallTable = options.toolCallTable ?? 'mcpsignals_tool_call';
  const sessionSummaryTable = options.sessionSummaryTable ?? 'mcpsignals_session_summary';

  let warnedOversizedArguments = false;

  function boundArguments(args: Record<string, unknown> | null): string | null {
    if (args === null) return null;
    const json = JSON.stringify(args);
    if (encoder.encode(json).length > MAX_ARGUMENTS_BYTES) {
      if (!warnedOversizedArguments) {
        warnedOversizedArguments = true;
        console.error(
          `[mcpsignals] d1Sink: dropping an oversized \`arguments\` payload (over ${MAX_ARGUMENTS_BYTES} bytes) ` +
            'rather than risk D1 failing the whole batch; further occurrences this instance are suppressed.'
        );
      }
      return null;
    }
    return json;
  }

  return {
    async write(events: AnyEvent[]): Promise<void> {
      const statements: D1PreparedStatement[] = events.map(event => {
        if (event.event_type === 'tool_call') {
          return db
            .prepare(
              `insert into ${toolCallTable}
                (ts, server_name, server_version, tool_name, session_id, agent_id, client_name, client_version,
                 user_id, org_id, duration_ms, success, error_kind, error_message, request_bytes, response_bytes,
                 arguments, intent, transport)
               values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            )
            .bind(
              event.ts.getTime(),
              event.server_name,
              event.server_version,
              event.tool_name,
              event.session_id,
              event.agent_id,
              event.client_name,
              event.client_version,
              event.user_id,
              event.org_id,
              event.duration_ms,
              event.success ? 1 : 0,
              event.error_kind,
              event.error_message,
              event.request_bytes,
              event.response_bytes,
              boundArguments(event.arguments),
              event.intent,
              event.transport
            );
        }

        return db
          .prepare(
            `insert into ${sessionSummaryTable}
              (ts, session_id, server_name, server_version, user_id, org_id, call_count, distinct_tools_used,
               wall_duration_ms, error_count)
             values (?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(
            event.ts.getTime(),
            event.session_id,
            event.server_name,
            event.server_version,
            event.user_id,
            event.org_id,
            event.call_count,
            event.distinct_tools_used,
            event.wall_duration_ms,
            event.error_count
          );
      });

      if (statements.length === 0) return;
      await db.batch(statements);
    }
  };
}
