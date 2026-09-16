/**
 * Length caps on the caller-controlled strings that land on an event: the
 * three intent-capture values the calling agent supplies, and the
 * `client_name`/`client_version` pair the client declares in its
 * `initialize` handshake. Without them a sink that batches writes in a
 * transaction (Cloudflare D1's `batch()`, for one) loses every unrelated
 * event in the flush when one oversized value fails its statement. Capping
 * in `instrument()` rather than in each sink means every sink, including
 * third-party and future ones, inherits the bound.
 *
 * `intent` is prose and takes the same 2000 as `error_message`.
 * `session_id`/`agent_id`/`client_name`/`client_version` are identifiers -
 * a UUID is 36 chars - so they take a much tighter cap. Oversized values are
 * truncated rather than dropped: losing the tail of an id is cheaper than
 * losing the event.
 */
export const MAX_INTENT_LENGTH = 2000;
export const MAX_IDENTIFIER_LENGTH = 128;

/** Returns `value` cut to `maxLength` UTF-16 code units, or null for a non-string. */
export function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length <= maxLength) return value;
  // slice() counts UTF-16 code units, so a naive cut at maxLength can land
  // between the two units of a surrogate pair (e.g. an emoji) and leave a
  // lone surrogate in the result - invalid UTF-16 that some UTF-8 encoders
  // (e.g. node-postgres) reject outright, which would make the value fail
  // the very sink write this bound exists to protect. Back the cut off by
  // one unit when it would split a pair.
  let end = maxLength;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
