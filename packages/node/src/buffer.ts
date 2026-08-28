import type { Sink } from './sinks/types.js';
import type { AnyEvent } from './events.js';

export interface EventBufferOptions {
  sinks: Sink[];
  bufferSize?: number;
  /**
   * Flush interval in ms. Pass `null` to disable the interval timer (and the
   * `beforeExit` listener) entirely — manual mode, for request-scoped
   * runtimes like Cloudflare Workers where a timer isn't guaranteed to fire
   * again before the isolate is evicted. In manual mode the caller is
   * responsible for calling `flush()` explicitly before the request ends
   * (e.g. `ctx.waitUntil(buffer.flush())`). Default: 5000.
   */
  flushIntervalMs?: number | null;
}

const DEFAULT_BUFFER_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;

/**
 * Batches events and flushes on a size threshold or an interval, whichever
 * comes first, plus a best-effort flush on process shutdown. A sink whose
 * `write` throws or rejects is caught and logged at most once per sink
 * instance — it never propagates to the caller, and never blocks the other
 * sinks (all sinks are written in parallel via `allSettled`). Pass
 * `flushIntervalMs: null` for manual mode: no timer, no `beforeExit`
 * listener, the caller flushes explicitly.
 */
export class EventBuffer {
  private readonly sinks: Sink[];
  private readonly bufferSize: number;
  private queue: AnyEvent[] = [];
  private readonly warned = new WeakSet<Sink>();
  private readonly timer?: NodeJS.Timeout;
  // Chains every flush's write so `flush()` always waits for the ones ahead
  // of it, not just for its own batch. Without this, the size-triggered
  // `void this.flush()` in `push()` is fire-and-forget: a caller who awaits
  // a *later* `flush()` call (e.g. `ctx.waitUntil(handle.flush())` on
  // Workers, right before returning the response) can see an already-empty
  // queue and resolve immediately, while the earlier batch's sink write is
  // still in flight — on an isolate-based runtime that write can then be cut
  // off before it lands. Chaining onto `pending` makes every `flush()` call
  // resolve only once every write started before it has settled.
  private pending: Promise<void> = Promise.resolve();
  private readonly onBeforeExit = () => {
    void this.flush();
  };

  constructor(options: EventBufferOptions) {
    this.sinks = options.sinks;
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    const manual = options.flushIntervalMs === null;

    if (!manual) {
      const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

      this.timer = setInterval(() => {
        void this.flush();
      }, flushIntervalMs);
      this.timer.unref?.();

      process.on('beforeExit', this.onBeforeExit);
    }
  }

  push(event: AnyEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.bufferSize) {
      void this.flush();
    }
  }

  flush(): Promise<void> {
    if (this.queue.length === 0) return this.pending;
    const batch = this.queue;
    this.queue = [];

    const write = this.writeBatch(batch);
    this.pending = this.pending.then(() => write);
    return this.pending;
  }

  private async writeBatch(batch: AnyEvent[]): Promise<void> {
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
