import type { Sink } from './types.js';
import type { AnyEvent } from '../events.js';

export interface PostgresSinkOptions {
  /** An existing `pg` Pool to reuse. If omitted, a new Pool is created from `pg`'s own env var defaults (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT, or a `connectionString`). */
  pool?: unknown;
  connectionString?: string;
  toolCallTable?: string;
  sessionSummaryTable?: string;
}

/**
 * Writes rows into the tables defined by schema/events.md's Postgres DDL.
 * Requires the optional peer dependency `pg` — dynamically imported so it
 * isn't required unless this sink is actually used.
 */
export function postgresSink(options: PostgresSinkOptions = {}): Sink {
  const toolCallTable = options.toolCallTable ?? 'mcpsignals_tool_call';
  const sessionSummaryTable = options.sessionSummaryTable ?? 'mcpsignals_session_summary';

  let poolPromise:
    | Promise<{ query: (text: string, values: unknown[]) => Promise<unknown> }>
    | undefined;

  async function getPool() {
    if (!poolPromise) {
      poolPromise = (async () => {
        if (options.pool) {
          return options.pool as { query: (text: string, values: unknown[]) => Promise<unknown> };
        }
        const pg = await import('pg');
        const Pool = pg.Pool ?? pg.default.Pool;
        return new Pool(
          options.connectionString ? { connectionString: options.connectionString } : undefined
        );
      })();
    }
    return poolPromise;
  }

  return {
    async write(events: AnyEvent[]): Promise<void> {
      const pool = await getPool();
      for (const event of events) {
        if (event.event_type === 'tool_call') {
          await pool.query(
            `insert into ${toolCallTable}
              (ts, server_name, server_version, tool_name, session_id, agent_id, client_name, client_version,
               user_id, org_id, duration_ms, success, error_kind, error_message, request_bytes, response_bytes,
               arguments, intent, transport)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [
              event.ts,
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
              event.success,
              event.error_kind,
              event.error_message,
              event.request_bytes,
              event.response_bytes,
              event.arguments,
              event.intent,
              event.transport
            ]
          );
        } else {
          await pool.query(
            `insert into ${sessionSummaryTable}
              (ts, session_id, server_name, server_version, user_id, org_id, call_count, distinct_tools_used,
               wall_duration_ms, error_count)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              event.ts,
              event.session_id,
              event.server_name,
              event.server_version,
              event.user_id,
              event.org_id,
              event.call_count,
              event.distinct_tools_used,
              event.wall_duration_ms,
              event.error_count
            ]
          );
        }
      }
    }
  };
}
