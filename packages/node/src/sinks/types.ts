import type { AnyEvent } from '../events.js';

export interface Sink {
  write(events: AnyEvent[]): Promise<void>;
}
