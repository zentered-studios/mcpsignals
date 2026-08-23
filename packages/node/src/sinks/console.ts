import type { Sink } from './types.js';
import type { AnyEvent } from '../events.js';

/** Zero-config default: writes one JSON line per event to stdout. */
export function consoleSink(): Sink {
  return {
    async write(events: AnyEvent[]): Promise<void> {
      for (const event of events) {
        process.stdout.write(JSON.stringify(event) + '\n');
      }
    }
  };
}
