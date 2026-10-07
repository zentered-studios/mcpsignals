import type { Sink } from './types.js';
import type { AnyEvent, ToolCallEvent } from '../events.js';

interface AnalyticsEngineDataPoint {
  indexes?: (string | null)[];
  doubles?: number[];
  blobs?: (string | null)[];
}

interface AnalyticsEngineDataset {
  writeDataPoint(point?: AnalyticsEngineDataPoint): void;
}

// developers.cloudflare.com/analytics/analytics-engine/limits/: "The total
// size of all blobs in a request must not exceed 16 KB", "Each index must not
// be more than 96 bytes", and "a maximum of 250 data points per Worker
// invocation". 16 KB is taken as 16,000 bytes, the lower reading.
const MAX_BLOB_BYTES = 16_000;
const MAX_INDEX_BYTES = 96;
const MAX_DATA_POINTS = 250;

const encoder = new TextEncoder();

/** Hints are tri-state, and a double cannot hold null: 1, 0, or -1 for "not declared". */
function hintDouble(value: boolean | null): number {
  return value === null ? -1 : value ? 1 : 0;
}

/** Cuts `value` to at most `maxBytes` of UTF-8 without splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (encoder.encode(value).length <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * The positional blob layout, in schema/events.md's field order. Reordering
 * it is a breaking change: queries read these as `blob1`..`blob19`.
 */
function blobsOf(event: ToolCallEvent): string[] {
  return [
    event.server_name,
    event.server_version ?? '',
    event.tool_name,
    event.session_id ?? '',
    event.agent_id ?? '',
    event.client_name ?? '',
    event.client_version ?? '',
    event.user_id ?? '',
    event.org_id ?? '',
    event.error_kind ?? '',
    event.error_message ?? '',
    event.arguments === null ? '' : JSON.stringify(event.arguments),
    event.intent ?? '',
    event.transport ?? '',
    event.protocol_version ?? '',
    event.request_id ?? '',
    event.trace_id ?? '',
    event.parent_span_id ?? '',
    event.result_type ?? ''
  ];
}

const ERROR_MESSAGE_BLOB = 10;
const ARGUMENTS_BLOB = 11;
const INTENT_BLOB = 12;
// Blobs that share what's left of the budget, in this order, when the total
// is over it. Everything else is an identifier or enum and is kept whole.
const SHRINKABLE_BLOBS = [ERROR_MESSAGE_BLOB, INTENT_BLOB, ARGUMENTS_BLOB];

/**
 * Writes one Workers Analytics Engine data point per `tool_call` event, via
 * an `AnalyticsEngineDataset` binding. Aggregate data only: it loses what
 * the D1 table keeps. See schema/events.md's Analytics Engine section for
 * the positional field mapping and the full list of losses.
 *
 * Requires `flushIntervalMs: null` (manual mode) and `ctx.waitUntil(flush())`,
 * same as `d1Sink`.
 *
 * Analytics Engine stamps its own `timestamp` at write time, so the event's
 * `ts` goes in `double1` as Unix epoch milliseconds. Null strings are written
 * as `""`, a null `error_code` as `0`, and a null hint as `-1`.
 *
 * Limits are enforced before writing, with a warning logged at most once
 * per sink instance for each:
 * - Blobs over 16 KB in total: `arguments` is dropped whole when it does not
 *   fit, since truncated JSON can't be parsed. `error_message`, then `intent`,
 *   share what is left, so `intent` can end up empty. If the identifier blobs
 *   alone are over 16 KB, they are cut in field order too.
 * - The index (`tool_name`) is cut to 96 bytes. `blob3` keeps it whole.
 * - A sink instance writes at most 250 data points in total. The rest are
 *   dropped. The limit is per Worker invocation, so create the sink per
 *   invocation, as in the example in the package README.
 */
export function analyticsEngineSink(dataset: AnalyticsEngineDataset): Sink {
  let warnedTruncated = false;
  let warnedOverCap = false;
  let remainingPoints = MAX_DATA_POINTS;

  function fitBlobs(blobs: string[]): string[] {
    const sizes = blobs.map(blob => encoder.encode(blob).length);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total <= MAX_BLOB_BYTES) return blobs;

    if (!warnedTruncated) {
      warnedTruncated = true;
      console.error(
        `[mcpsignals] analyticsEngineSink: truncating a data point's blobs to ${MAX_BLOB_BYTES} bytes ` +
          '(arguments dropped, intent and error_message cut, then any remaining blob); further occurrences this instance are suppressed.'
      );
    }

    const fitted = [...blobs];
    let budget =
      MAX_BLOB_BYTES -
      sizes.reduce((sum, size, i) => (SHRINKABLE_BLOBS.includes(i) ? sum : sum + size), 0);
    for (const i of SHRINKABLE_BLOBS) {
      if (i === ARGUMENTS_BLOB) {
        fitted[i] = sizes[i] <= budget ? blobs[i] : '';
      } else {
        fitted[i] = truncateUtf8(blobs[i], Math.max(budget, 0));
      }
      budget -= encoder.encode(fitted[i]).length;
    }

    // The identifiers alone can be over budget. Cut them in field order, so
    // the point still fits and every blob keeps its position.
    let remaining = MAX_BLOB_BYTES;
    return fitted.map(blob => {
      const kept = truncateUtf8(blob, remaining);
      remaining -= encoder.encode(kept).length;
      return kept;
    });
  }

  return {
    async write(events: AnyEvent[]): Promise<void> {
      const toolCalls = events.filter(event => event.event_type === 'tool_call');
      if (toolCalls.length > remainingPoints && !warnedOverCap) {
        warnedOverCap = true;
        console.error(
          `[mcpsignals] analyticsEngineSink: dropping ${toolCalls.length - remainingPoints} event(s) over the ` +
            `${MAX_DATA_POINTS} data points Analytics Engine accepts per Worker invocation; ` +
            'further occurrences this instance are suppressed.'
        );
      }

      const accepted = toolCalls.slice(0, remainingPoints);
      remainingPoints -= accepted.length;
      for (const event of accepted) {
        dataset.writeDataPoint({
          indexes: [truncateUtf8(event.tool_name, MAX_INDEX_BYTES)],
          blobs: fitBlobs(blobsOf(event)),
          doubles: [
            event.ts.getTime(),
            event.duration_ms,
            event.success ? 1 : 0,
            event.request_bytes,
            event.response_bytes,
            event.error_code ?? 0,
            hintDouble(event.read_only_hint),
            hintDouble(event.destructive_hint)
          ]
        });
      }
    }
  };
}
