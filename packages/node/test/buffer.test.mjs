import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBuffer } from '../dist/index.mjs';

function makeEvent(i) {
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
    transport: null
  };
}

test('flushes on the size threshold without waiting for the interval', async () => {
  const written = [];
  const sink = { write: async batch => void written.push(...batch) };
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
  const written = [];
  const sink = { write: async batch => void written.push(...batch) };
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
  const written = [];
  const sink = { write: async batch => void written.push(...batch) };
  const buffer = new EventBuffer({ sinks: [sink], bufferSize: 100, flushIntervalMs: null });

  buffer.push(makeEvent(1));
  t.mock.timers.tick(10 * 60 * 1000); // far past the default 5s interval
  assert.equal(written.length, 0, 'manual mode must not schedule any interval');

  buffer.stop();
});

test('manual mode: flushIntervalMs null flushes only when flush() is called explicitly', async () => {
  const written = [];
  const sink = { write: async batch => void written.push(...batch) };
  const buffer = new EventBuffer({ sinks: [sink], bufferSize: 100, flushIntervalMs: null });

  buffer.push(makeEvent(1));
  await buffer.flush();
  assert.equal(written.length, 1);

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
  const goodSinkEvents = [];
  const failingSink = {
    write: async () => {
      throw new Error('nope');
    }
  };
  const goodSink = { write: async batch => void goodSinkEvents.push(...batch) };
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
