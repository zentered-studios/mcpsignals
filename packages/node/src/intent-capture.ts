import { z } from 'zod';

export const INTENT_CAPTURE_KEYS = ['session_id', 'agent_id', 'intent'] as const;
export type IntentCaptureKey = (typeof INTENT_CAPTURE_KEYS)[number];

export type IntentCaptureOption = boolean | { tools?: Record<string, boolean> };

export function isIntentCaptureEnabled(
  option: IntentCaptureOption | undefined,
  toolName: string
): boolean {
  if (!option) return false;
  if (option === true) return true;
  return option.tools?.[toolName] ?? false;
}

const INTENT_FIELDS = {
  session_id: z.string().optional().describe('Groups this call with others in the same task.'),
  agent_id: z
    .string()
    .optional()
    .describe('Distinguishes this agent from others running in parallel.'),
  intent: z.string().optional().describe('Why you are calling this tool.')
};

/**
 * Extends a tool's input schema with optional session_id/agent_id/intent
 * fields so the client can see and populate them. Handles a full Zod object
 * schema (`.extend()`), a raw shape record (plain object merge, the legacy
 * `registerTool` form), and no schema at all (a fresh object schema with
 * just the three injected fields). Returns the input unchanged for any other
 * Standard Schema (e.g. Valibot/ArkType) — injection is skipped rather than
 * risking a crash on a schema shape this library doesn't understand; the
 * caller should treat that as "intent capture unavailable for this tool."
 */
export function injectIntentSchema<T>(inputSchema: T): T {
  if (inputSchema === undefined) {
    return z.object(INTENT_FIELDS) as unknown as T;
  }
  if (inputSchema instanceof z.ZodObject) {
    return inputSchema.extend(INTENT_FIELDS) as unknown as T;
  }
  if (
    typeof inputSchema === 'object' &&
    inputSchema !== null &&
    Object.values(inputSchema as Record<string, unknown>).every(v => v instanceof z.ZodType)
  ) {
    return { ...(inputSchema as Record<string, unknown>), ...INTENT_FIELDS } as unknown as T;
  }
  return inputSchema;
}

/** True if `injectIntentSchema` actually added the injected fields for this input. */
export function schemaSupportsInjection(inputSchema: unknown): boolean {
  if (inputSchema === undefined) return true;
  if (inputSchema instanceof z.ZodObject) return true;
  return (
    typeof inputSchema === 'object' &&
    inputSchema !== null &&
    Object.values(inputSchema as Record<string, unknown>).every(v => v instanceof z.ZodType)
  );
}

/**
 * Length caps on the three values the calling agent supplies. Without them
 * these are the only unbounded caller-controlled strings on an event, and a
 * sink that batches writes in a transaction (Cloudflare D1's `batch()`, for
 * one) loses every unrelated event in the flush when one oversized value
 * fails its statement. Capping here rather than in each sink means every
 * sink, including third-party and future ones, inherits the bound.
 *
 * `intent` is prose and takes the same 2000 as `error_message`.
 * `session_id`/`agent_id` are identifiers - a UUID is 36 chars - so they take
 * a much tighter cap. Oversized values are truncated rather than dropped:
 * losing the tail of an id is cheaper than losing the event.
 */
export const MAX_INTENT_LENGTH = 2000;
export const MAX_IDENTIFIER_LENGTH = 128;

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export interface ExtractedIntent {
  session_id: string | null;
  agent_id: string | null;
  intent: string | null;
  clean: Record<string, unknown>;
}

/**
 * Reads the injected keys off parsed args and returns args with those keys
 * removed. The extracted values are length-bounded; `clean` is untouched
 * beyond the removal, so the handler still receives exactly what it would
 * have received without the library.
 */
export function extractAndStripIntent(args: Record<string, unknown>): ExtractedIntent {
  const clean = { ...args };
  const session_id = boundedString(clean.session_id, MAX_IDENTIFIER_LENGTH);
  const agent_id = boundedString(clean.agent_id, MAX_IDENTIFIER_LENGTH);
  const intent = boundedString(clean.intent, MAX_INTENT_LENGTH);
  delete clean.session_id;
  delete clean.agent_id;
  delete clean.intent;
  return { session_id, agent_id, intent, clean };
}
