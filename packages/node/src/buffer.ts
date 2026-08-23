import type { Sink } from './sinks/types.js';
import type { AnyEvent } from './events.js';

export interface EventBufferOptions {
  sinks: Sink[];
  bufferSize?: number;
  flushIntervalMs?: number;
}

const DEFAULT_BUFFER_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;

/**
 * Batches events and flushes on a size threshold or an interval, whichever
 * comes first, plus a best-effort flush on process shutdown. A sink whose
 * `write` throws or rejects is caught and logged at most once per sink
 * instance — it never propagates to the caller, and never blocks the other
 * sinks (all sinks are written in parallel via `allSettled`).
 */
export class EventBuffer {
  private readonly sinks: Sink[];
  private readonly bufferSize: number;
  private queue: AnyEvent[] = [];
  private readonly warned = new WeakSet<Sink>();
  private readonly timer: NodeJS.Timeout;
  private readonly onBeforeExit = () => {
    void this.flush();
  };

  constructor(options: EventBufferOptions) {
    this.sinks = options.sinks;
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    this.timer = setInterval(() => {
      void this.flush();
    }, flushIntervalMs);
    this.timer.unref?.();

    process.on('beforeExit', this.onBeforeExit);
  }

  push(event: AnyEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.bufferSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];

    await Promise.allSettled(
      this.sinks.map(async sink => {
        try {
          await sink.write(batch);
        } catch (error) {
          if (!this.warned.has(sink)) {
            this.warned.add(sink);
            console.error(
              '[mcpsignals] sink failed, further errors from this sink are suppressed:',
              error
            );
          }
        }
      })
    );
  }

  stop(): void {
    clearInterval(this.timer);
    process.off('beforeExit', this.onBeforeExit);
  }
}
