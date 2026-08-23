import type { Sink } from './types.js';
import type { AnyEvent } from '../events.js';

export interface BigQuerySinkOptions {
  /** BigQuery project id. Defaults to the client library's own ADC-based resolution. */
  projectId?: string;
  dataset?: string;
  toolCallTable?: string;
  sessionSummaryTable?: string;
}

interface BigQueryTable {
  insert(rows: Record<string, unknown>[]): Promise<unknown>;
}
interface BigQueryClient {
  dataset(name: string): { table(name: string): BigQueryTable };
}

/**
 * Streams rows into the tables defined by schema/events.md's BigQuery DDL.
 * Requires the optional peer dependency `@google-cloud/bigquery` —
 * dynamically imported so it isn't required unless this sink is actually
 * used. Credentials come from Application Default Credentials, same as the
 * client library's own defaults.
 */
export function bigquerySink(options: BigQuerySinkOptions = {}): Sink {
  const dataset = options.dataset ?? 'mcpsignals';
  const toolCallTable = options.toolCallTable ?? 'tool_call';
  const sessionSummaryTable = options.sessionSummaryTable ?? 'session_summary';

  let clientPromise: Promise<BigQueryClient> | undefined;

  async function getClient(): Promise<BigQueryClient> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const mod = await import('@google-cloud/bigquery');
        const BigQuery = mod.BigQuery;
        return new BigQuery(
          options.projectId ? { projectId: options.projectId } : undefined
        ) as unknown as BigQueryClient;
      })();
    }
    return clientPromise;
  }

  return {
    async write(events: AnyEvent[]): Promise<void> {
      const client = await getClient();
      const toolCalls = events.filter(
        (e): e is Extract<AnyEvent, { event_type: 'tool_call' }> => e.event_type === 'tool_call'
      );
      const sessionSummaries = events.filter(
        (e): e is Extract<AnyEvent, { event_type: 'session_summary' }> =>
          e.event_type === 'session_summary'
      );

      if (toolCalls.length > 0) {
        await client
          .dataset(dataset)
          .table(toolCallTable)
          .insert(
            toolCalls.map(e => ({
              ts: e.ts.toISOString(),
              server_name: e.server_name,
              server_version: e.server_version,
              tool_name: e.tool_name,
              session_id: e.session_id,
              agent_id: e.agent_id,
              client_name: e.client_name,
              client_version: e.client_version,
              user_id: e.user_id,
              org_id: e.org_id,
              duration_ms: e.duration_ms,
              success: e.success,
              error_kind: e.error_kind,
              error_message: e.error_message,
              request_bytes: e.request_bytes,
              response_bytes: e.response_bytes,
              arguments: e.arguments ? JSON.stringify(e.arguments) : null,
              intent: e.intent,
              transport: e.transport
            }))
          );
      }

      if (sessionSummaries.length > 0) {
        await client
          .dataset(dataset)
          .table(sessionSummaryTable)
          .insert(
            sessionSummaries.map(e => ({
              ts: e.ts.toISOString(),
              session_id: e.session_id,
              server_name: e.server_name,
              server_version: e.server_version,
              user_id: e.user_id,
              org_id: e.org_id,
              call_count: e.call_count,
              distinct_tools_used: e.distinct_tools_used,
              wall_duration_ms: e.wall_duration_ms,
              error_count: e.error_count
            }))
          );
      }
    }
  };
}
