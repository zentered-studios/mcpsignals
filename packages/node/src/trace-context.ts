/**
 * The trace and parent span ids of a W3C `traceparent`
 * (https://www.w3.org/TR/trace-context/#traceparent-header), or null when the
 * value is not a valid one. MCP carries it unprefixed in a request's `_meta`
 * (the spec's named exception to the `_meta` key-prefix rule).
 *
 * The client controls this value, so anything that is not exactly the
 * format is dropped rather than recorded: a version of `ff`, an all-zero id,
 * or a version-00 header with trailing fields. A higher version may append
 * fields; only the first four are read, as the W3C spec requires.
 */
export function parseTraceparent(value: unknown): { traceId: string; parentSpanId: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}(-.*)?$/.exec(value);
  if (!match) return null;
  const [, version, traceId, parentSpanId, rest] = match;
  if (version === 'ff' || (version === '00' && rest !== undefined)) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null;
  return { traceId, parentSpanId };
}
