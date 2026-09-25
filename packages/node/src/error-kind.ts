import { ERROR_KINDS, type ErrorKind } from './events.js';

/** True when `value` is one of `ERROR_KINDS`. */
export function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && (ERROR_KINDS as readonly string[]).includes(value);
}

/**
 * Best-effort heuristic over free-text error messages. Not a structured
 * code — `success` is the ground truth for pass/fail. See schema/events.md
 * for the documented false-positive mode.
 */
export function classifyError(message: string | undefined | null): ErrorKind | null {
  if (!message) return null;

  if (/not found|does not exist|no such/i.test(message)) return 'not_found';
  if (/\bempty\b|no results?|nothing found|zero results/i.test(message)) return 'empty';
  if (/invalid|required|expected|must be|validation|schema/i.test(message)) return 'validation';
  return 'internal';
}
