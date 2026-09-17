import type { Sink } from './types.js';
import type { AnyEvent, ToolCallEvent } from '../events.js';

export interface PostgresSinkOptions {
  /** An existing `pg` Pool to reuse. If omitted, a new Pool is created from `pg`'s own env var defaults (PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT, or a `connectionString`). */
  pool?: unknown;
  connectionString?: string;
  toolCallTable?: string;
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

function toolCallRow(event: ToolCallEvent): unknown[] {
  return TOOL_CALL_COLUMNS.map(column => event[column]);
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
 * Writes rows into the table defined by schema/events.md's Postgres DDL.
 * Requires the optional peer dependency `pg` — dynamically imported so it
 * isn't required unless this sink is actually used.
 *
 * Each `write()` issues at most one multi-row insert for the batch.
 */
export function postgresSink(options: PostgresSinkOptions = {}): Sink {
  const toolCallTable = options.toolCallTable ?? 'mcpsignals_tool_call';

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
      const toolCallRows = events
        .filter(event => event.event_type === 'tool_call')
        .map(event => toolCallRow(event));
      if (toolCallRows.length === 0) {
        return;
      }

      const pool = await getPool();
      const { text, values } = buildMultiRowInsert(toolCallTable, TOOL_CALL_COLUMNS, toolCallRows);
      await pool.query(text, values);
    }
  };
}
