export interface RedactionConfig {
  /** Keys to record with their real value. If set, every key not listed here is type-only. */
  allow?: string[];
  /** Keys to always record as type-only, regardless of `allow`. */
  deny?: string[];
  /** Full override: receives the raw arguments, returns exactly what gets recorded. Wins over allow/deny. */
  redactor?: (args: Record<string, unknown>) => Record<string, unknown>;
}

function typeOnly(value: unknown): { __type: string } {
  return { __type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
}

/**
 * Argument capture is opt-in (`captureArguments`). When on with no redaction
 * config, only key names and value *types* are recorded — never values. Real
 * values are recorded only for keys explicitly named in `allow`.
 */
export function applyRedaction(
  args: Record<string, unknown>,
  config: RedactionConfig | undefined,
  captureArguments: boolean | undefined
): Record<string, unknown> | null {
  if (!captureArguments) return null;

  if (config?.redactor) {
    return config.redactor(args);
  }

  const allow = config?.allow;
  const deny = config?.deny ?? [];

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const allowed = allow !== undefined && allow.includes(key) && !deny.includes(key);
    result[key] = allowed ? value : typeOnly(value);
  }
  return result;
}
