import type { Sink } from './types.js';
import type { AnyEvent, SessionSummaryEvent, ToolCallEvent } from '../events.js';

export interface PostgresSinkOptions {
  /** An existing `pg` Pool to reuse. If omitted, a new Pool is created from `pg`'s own env var defaults (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT, or a `connectionString`). */
  pool?: unknown;
  connectionString?: string;
  toolCallTable?: string;
  sessionSummaryTable?: string;
}

interface QueryablePool {
  query: (text: string, values: unknown[]) => Promise<unknown>;
}

const TOOL_CALL_COLUMNS = [
  'ts',
  'server_name',
  'server_version',
  'tool_name',
  'session_id',
  'agent_id',
  'client_name',
  'client_version',
  'user_id',
  'org_id',
  'duration_ms',
  'success',
  'error_kind',
  'error_message',
  'request_bytes',
  'response_bytes',
  'arguments',
  'intent',
  'transport'
] as const;

const SESSION_SUMMARY_COLUMNS = [
  'ts',
  'session_id',
  'server_name',
  'server_version',
  'user_id',
  'org_id',
  'call_count',
  'distinct_tools_used',
  'wall_duration_ms',
  'error_count'
] as const;

function toolCallRow(event: ToolCallEvent): unknown[] {
  return TOOL_CALL_COLUMNS.map(column => event[column]);
}

function sessionSummaryRow(event: SessionSummaryEvent): unknown[] {
  return SESSION_SUMMARY_COLUMNS.map(column => event[column]);
}

/**
 * Builds one `insert into <table> (cols) values ($1,...),($n+1,...),...`
 * statement for all rows, with a flat bind array in column order. `pg`
 * encodes each bound value itself (Date -> timestamp string, plain object ->
 * JSON), so rows are passed through as-is.
 *
 * Postgres caps a statement at 65535 bind parameters; at 19 columns that is
 * 3449 rows per statement, far above the default buffer size of 20, so the
 * rows are not chunked.
 */
function buildMultiRowInsert(
  table: string,
  columns: readonly string[],
  rows: unknown[][]
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const row of rows) {
    const placeholders = row.map((_, i) => `$${values.length + i + 1}`);
    tuples.push(`(${placeholders.join(',')})`);
    values.push(...row);
  }
  const text = `insert into ${table} (${columns.join(', ')}) values ${tuples.join(',')}`;
  return { text, values };
}

/**
 * Writes rows into the tables defined by schema/events.md's Postgres DDL.
 * Requires the optional peer dependency `pg` — dynamically imported so it
 * isn't required unless this sink is actually used.
 *
 * Each `write()` issues at most one multi-row insert per table: one for
 * the tool_call rows and one for the session_summary rows in the batch.
 */
export function postgresSink(options: PostgresSinkOptions = {}): Sink {
  const toolCallTable = options.toolCallTable ?? 'mcpsignals_tool_call';
  const sessionSummaryTable = options.sessionSummaryTable ?? 'mcpsignals_session_summary';

  let poolPromise: Promise<QueryablePool> | undefined;

  async function getPool() {
    if (!poolPromise) {
      poolPromise = (async () => {
        if (options.pool) {
          return options.pool as QueryablePool;
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
      const toolCallRows: unknown[][] = [];
      const sessionSummaryRows: unknown[][] = [];
      for (const event of events) {
        if (event.event_type === 'tool_call') {
          toolCallRows.push(toolCallRow(event));
        } else {
          sessionSummaryRows.push(sessionSummaryRow(event));
        }
      }
      if (toolCallRows.length === 0 && sessionSummaryRows.length === 0) {
        return;
      }

      const pool = await getPool();
      if (toolCallRows.length > 0) {
        const { text, values } = buildMultiRowInsert(
          toolCallTable,
          TOOL_CALL_COLUMNS,
          toolCallRows
        );
        await pool.query(text, values);
      }
      if (sessionSummaryRows.length > 0) {
        const { text, values } = buildMultiRowInsert(
          sessionSummaryTable,
          SESSION_SUMMARY_COLUMNS,
          sessionSummaryRows
        );
        await pool.query(text, values);
      }
    }
  };
}
