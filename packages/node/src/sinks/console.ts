import type { Sink } from './types.js';
import type { AnyEvent } from '../events.js';

export interface ConsoleSinkOptions {
  /**
   * Where the JSON lines go. Defaults to `process.stdout`.
   *
   * On a stdio transport, stdout is the MCP wire: the spec says the server
   * MUST NOT write anything to stdout that is not a valid MCP message, and
   * MAY log to stderr. Pass `process.stderr` there.
   */
  stream?: NodeJS.WritableStream;
}

/** Zero-config default: writes one JSON line per event to stdout. */
export function consoleSink(options: ConsoleSinkOptions = {}): Sink {
  const stream = options.stream ?? process.stdout;
  return {
    async write(events: AnyEvent[]): Promise<void> {
      for (const event of events) {
        stream.write(JSON.stringify(event) + '\n');
      }
    }
  };
}
