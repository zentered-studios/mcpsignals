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
 * Postgres sends a statement's bind-parameter count as an unsigned 16-bit
 * integer on the wire, so 65535 is a hard protocol ceiling, not a tunable.
 * A statement over it is rejected outright, which would cost the entire
 * flush rather than one row.
 */
const MAX_BIND_PARAMETERS = 65535;

/**
 * Builds one `insert into <table> (cols) values ($1,...),($n+1,...),...`
 * statement for all rows, with a flat bind array in column order. `pg`
 * encodes each bound value itself (Date -> timestamp string, plain object ->
 * JSON), so rows are passed through as-is.
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
 * Splits `rows` into as few statements as the bind-parameter ceiling allows.
 * At 19 tool_call columns that is 3449 rows each, far above the default
 * buffer size of 20 - but `bufferSize` is a public option, so a batch can
 * arrive well above it, and an unchunked statement would be rejected and
 * take the whole flush with it.
 *
 * Chunks are issued as separate statements, not wrapped in a transaction:
 * this sink already issues one statement per table without one, so a
 * mid-flush failure can leave earlier rows committed either way. Events are
 * append-only observations, so a partial flush is strictly better than none.
 */
function buildChunkedInserts(
  table: string,
  columns: readonly string[],
  rows: unknown[][]
): { text: string; values: unknown[] }[] {
  const rowsPerStatement = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columns.length));
  const statements: { text: string; values: unknown[] }[] = [];
  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    statements.push(buildMultiRowInsert(table, columns, rows.slice(i, i + rowsPerStatement)));
  }
  return statements;
}

/**
 * Writes rows into the table defined by schema/events.md's Postgres DDL.
 * Requires the optional peer dependency `pg` — dynamically imported so it
 * isn't required unless this sink is actually used.
 *
 * Each `write()` issues one multi-row insert for the batch. A batch whose
 * rows would exceed Postgres's 65535 bind-parameter ceiling is split across
 * as few additional statements as that ceiling allows.
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
      const statements = buildChunkedInserts(toolCallTable, TOOL_CALL_COLUMNS, toolCallRows);

      // Sequential on purpose, so `no-await-in-loop` is disabled rather than
      // satisfied with `Promise.all`. Chunking only happens on batches large
      // enough to need it, and firing every chunk at once would claim that
      // many pool connections simultaneously - a telemetry flush competing
      // with the host application's own queries for the pool is exactly the
      // kind of interference this library must never cause.
      for (const { text, values } of statements) {
        // oxlint-disable-next-line no-await-in-loop
        await pool.query(text, values);
      }
    }
  };
}
