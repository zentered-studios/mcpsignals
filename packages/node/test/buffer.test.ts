import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBuffer, type AnyEvent, type ToolCallEvent } from 'mcpsignals';

function makeEvent(i: number): ToolCallEvent {
  return {
    event_type: 'tool_call',
    ts: new Date(),
    server_name: 's',
    server_version: null,
    tool_name: `tool-${i}`,
    session_id: null,
    agent_id: null,
    client_name: null,
    client_version: null,
    user_id: null,
    org_id: null,
    duration_ms: 1,
    success: true,
    error_kind: null,
    error_message: null,
    request_bytes: 1,
    response_bytes: 1,
    arguments: null,
    intent: null,
    transport: null,
    protocol_version: null,
    request_id: null,
    trace_id: null,
    parent_span_id: null,
    result_type: null,
    error_code: null,
    read_only_hint: null,
    destructive_hint: null
  };
}

test('flushes on the size threshold without waiting for the interval', async () => {
  const written: AnyEvent[] = [];
  const sink = { write: async (batch: AnyEvent[]) => void written.push(...batch) };
  const buffer = new EventBuffer({ sinks: [sink], bufferSize: 3, flushIntervalMs: 60_000 });

  buffer.push(makeEvent(1));
  buffer.push(makeEvent(2));
  assert.equal(written.length, 0, 'should not flush before the threshold');
  buffer.push(makeEvent(3));

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(written.length, 3);
  buffer.stop();
});

test('flushes on the interval even under the size threshold', async () => {
  const written: AnyEvent[] = [];
  const sink = { write: async (batch: AnyEvent[]) => void written.push(...batch) };
  const buffer = new EventBuffer({ sinks: [sink], bufferSize: 100, flushIntervalMs: 20 });

  buffer.push(makeEvent(1));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(written.length, 1);
  buffer.stop();
});

test('a throwing sink is caught, logged at most once, and never propagates', async () => {
  let callCount = 0;
  const sink = {
    write: async () => {
      callCount++;
      throw new Error('sink is down');
    }
  };
  const originalConsoleError = console.error;
  let warnCount = 0;
  console.error = () => void warnCount++;

  try {
    const buffer = new EventBuffer({ sinks: [sink], bufferSize: 1, flushIntervalMs: 60_000 });
    buffer.push(makeEvent(1));
    buffer.push(makeEvent(2));
    await new Promise(resolve => setTimeout(resolve, 10));
    buffer.stop();

    assert.equal(callCount, 2, 'the sink is still called for every flush');
    assert.equal(warnCount, 1, 'the failure is logged at most once per sink instance');
  } finally {
    console.error = originalConsoleError;
  }
});

test('manual mode: flushIntervalMs null never auto-flushes on any interval', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const written: AnyEvent[] = [];
  const sink = { write: async (batch: AnyEvent[]) => void written.push(...batch) };
  const buffer = new EventBuffer({ sinks: [sink], bufferSize: 100, flushIntervalMs: null });

  buffer.push(makeEvent(1));
  t.mock.timers.tick(10 * 60 * 1000); // far past the default 5s interval
  assert.equal(written.length, 0, 'manual mode must not schedule any interval');

  buffer.stop();
});

test('manual mode: flushIntervalMs null flushes only when flush() is called explicitly', async () => {
  const written: AnyEvent[] = [];
  const sink = { write: async (batch: AnyEvent[]) => void written.push(...batch) };
  const buffer = new EventBuffer({ sinks: [sink], bufferSize: 100, flushIntervalMs: null });

  buffer.push(makeEvent(1));
  await buffer.flush();
  assert.equal(written.length, 1);

  buffer.stop();
});

test('manual mode: flush() awaits a size-triggered auto-flush already in flight, not just its own (possibly empty) batch', async () => {
  const written: AnyEvent[] = [];
  // Definite assignment: set synchronously inside the Promise executor below,
  // before any code that reads it runs.
  let resolveWrite!: () => void;
  const sink = {
    write: (batch: AnyEvent[]) =>
      new Promise<void>(resolve => {
        resolveWrite = () => {
          written.push(...batch);
          resolve();
        };
      })
  };
  // bufferSize 1: the very first push() triggers push()'s own fire-and-forget
  // `void this.flush()` before the caller ever calls flush() itself.
  const buffer = new EventBuffer({ sinks: [sink], bufferSize: 1, flushIntervalMs: null });

  buffer.push(makeEvent(1));
  // The queue is already empty by the time we call flush() ourselves - a naive
  // "return early if the queue is empty" implementation would resolve here
  // immediately, before the sink write (still pending on resolveWrite) lands.
  const flushed = buffer.flush();
  let settled = false;
  flushed.then(() => void (settled = true));

  await Promise.resolve(); // let microtasks run without resolving the write
  assert.equal(settled, false, 'flush() must not resolve while the in-flight write is pending');

  resolveWrite();
  await flushed;
  assert.equal(
    written.length,
    1,
    'the in-flight write must have completed by the time flush() resolves'
  );

  buffer.stop();
});

test('manual mode: flushIntervalMs null registers no beforeExit listener', () => {
  const before = process.listenerCount('beforeExit');
  const buffer = new EventBuffer({
    sinks: [{ write: async () => {} }],
    flushIntervalMs: null
  });
  assert.equal(process.listenerCount('beforeExit'), before);
  buffer.stop();
});

test('default mode still registers a beforeExit listener, removed by stop()', () => {
  const before = process.listenerCount('beforeExit');
  const buffer = new EventBuffer({ sinks: [{ write: async () => {} }], flushIntervalMs: 60_000 });
  assert.equal(process.listenerCount('beforeExit'), before + 1);
  buffer.stop();
  assert.equal(process.listenerCount('beforeExit'), before);
});

test('one sink failing does not block another sink from receiving the batch', async () => {
  const goodSinkEvents: AnyEvent[] = [];
  const failingSink = {
    write: async () => {
      throw new Error('nope');
    }
  };
  const goodSink = { write: async (batch: AnyEvent[]) => void goodSinkEvents.push(...batch) };
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const buffer = new EventBuffer({
      sinks: [failingSink, goodSink],
      bufferSize: 1,
      flushIntervalMs: 60_000
    });
    buffer.push(makeEvent(1));
    await new Promise(resolve => setTimeout(resolve, 10));
    buffer.stop();
    assert.equal(goodSinkEvents.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
});

test('stop() clears the interval: a push() after stop() is never auto-flushed by the timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const written: AnyEvent[] = [];
  const sink = { write: async (batch: AnyEvent[]) => void written.push(...batch) };

  // Control: with the timer still running, the same tick flushes the event,
  // so the assertion below cannot pass just because mocked timers never fire.
  const running = new EventBuffer({ sinks: [sink], bufferSize: 100, flushIntervalMs: 20 });
  running.push(makeEvent(1));
  t.mock.timers.tick(20);
  await Promise.resolve();
  assert.equal(written.length, 1, 'sanity: the mocked interval does drive a flush');
  running.stop();

  const stopped = new EventBuffer({ sinks: [sink], bufferSize: 100, flushIntervalMs: 20 });
  stopped.stop();
  stopped.push(makeEvent(2));
  t.mock.timers.tick(10 * 60 * 1000);
  await Promise.resolve();
  assert.equal(written.length, 1, 'stop() must clear the interval so nothing more is flushed');
});
