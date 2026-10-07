import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import {
  ERROR_KIND_META_KEY,
  EventBuffer,
  type InstrumentOptions,
  type TelemetryErrorStep
} from 'mcpsignals';
import { createInstrumentedServer, connectClient, textOf } from './helpers.js';

// `onError` (#99): a telemetry failure's raw error can carry tool arguments,
// so a configured hook replaces the console diagnostic. Each test breaks one
// library-side step with an error carrying `marker` and asserts the marker
// never reaches the console, the hook sees the fixed step once per
// instrument() call, and the client's result is untouched.

const marker = 'SecretMarker604';
const requestSentinel = 'fault-in-request-bytes';
const responseSentinel = 'fault-in-response-bytes';

function markerError() {
  return Object.assign(new Error(marker), { name: marker, stack: marker });
}

function spyConsole() {
  return (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    mock.method(console, method, () => {})
  );
}

/**
 * Manual flush mode: the default mode adds a `beforeExit` listener per
 * instance, and Node's MaxListenersExceededWarning would reach console.error.
 */
function instrumented(options: Partial<InstrumentOptions>) {
  return createInstrumentedServer({ flushIntervalMs: null, ...options });
}

function assertConsoleSilent(spies: ReturnType<typeof spyConsole>) {
  for (const spy of spies) {
    assert.equal(spy.mock.callCount(), 0, 'no raw console fallback');
  }
}

/** Byte counting runs through TextEncoder; throw only for the sentinel the test planted. */
function breakEncoderOn(sentinel: string, error: Error) {
  const original = TextEncoder.prototype.encode;
  return mock.method(TextEncoder.prototype, 'encode', function (this: TextEncoder, input?: string) {
    if (typeof input === 'string' && input.includes(sentinel)) throw error;
    return original.call(this, input);
  });
}

interface StepCase {
  step: TelemetryErrorStep;
  label: string;
  options?: (failure: Error) => Partial<InstrumentOptions>;
  /** Installs a fault after the client connects; returns its restore. */
  inject?: (server: McpServer, failure: Error) => () => void;
  /** The tool's result, built per call. */
  result?: (failure: Error) => Record<string, unknown>;
  args?: Record<string, unknown>;
  /** Whether the event survives the failure. */
  recorded: boolean;
  check?: (event: Record<string, unknown>) => void;
}

const stepCases: StepCase[] = [
  {
    step: 'request byte count',
    label: 'request byte count',
    args: { form: requestSentinel },
    inject: (_server, failure) => {
      const spy = breakEncoderOn(requestSentinel, failure);
      return () => spy.mock.restore();
    },
    recorded: true,
    check: event => assert.equal(event.request_bytes, 0)
  },
  {
    step: 'response byte count',
    label: 'response byte count',
    result: () => ({ content: [{ type: 'text', text: responseSentinel }] }),
    inject: (_server, failure) => {
      const spy = breakEncoderOn(responseSentinel, failure);
      return () => spy.mock.restore();
    },
    recorded: true,
    check: event => assert.equal(event.response_bytes, 0)
  },
  {
    step: 'resolveIdentity',
    label: 'resolveIdentity',
    options: failure => ({
      resolveIdentity: async () => {
        throw failure;
      }
    }),
    recorded: true,
    check: event => {
      assert.equal(event.user_id, null);
      assert.equal(event.org_id, null);
    }
  },
  {
    step: 'redaction',
    label: 'redaction',
    options: failure => ({
      captureArguments: true,
      redaction: {
        redactor: () => {
          throw failure;
        }
      }
    }),
    recorded: true
  },
  {
    step: 'declared error kind',
    label: 'declared error kind',
    result: () => ({
      content: [{ type: 'text', text: 'widget not found' }],
      isError: true,
      _meta: {}
    }),
    // The SDK copies `_meta` into a plain object before the recorder reads it,
    // so a throwing Proxy never arrives. Throw from the prototype instead.
    inject: (_server, failure) => {
      // oxlint-disable-next-line no-extend-native
      Object.defineProperty(Object.prototype, ERROR_KIND_META_KEY, {
        configurable: true,
        get() {
          throw failure;
        }
      });
      return () => {
        delete (Object.prototype as Record<string, unknown>)[ERROR_KIND_META_KEY];
      };
    },
    recorded: true,
    check: event => assert.equal(event.error_kind, 'not_found')
  },
  {
    step: 'event recording',
    label: 'event construction (client metadata)',
    inject: (server, failure) => {
      const spy = mock.method(server.server, 'getClientVersion', () => {
        throw failure;
      });
      return () => spy.mock.restore();
    },
    recorded: false
  },
  {
    step: 'event recording',
    label: 'buffer push',
    inject: (_server, failure) => {
      const spy = mock.method(EventBuffer.prototype, 'push', () => {
        throw failure;
      });
      return () => spy.mock.restore();
    },
    recorded: false
  }
];

for (const c of stepCases) {
  test(`onError: ${c.label} failure reaches the hook once as "${c.step}", never the console`, async () => {
    const failure = markerError();
    const seen: [TelemetryErrorStep, unknown][] = [];
    const { server, events, flush } = instrumented({
      ...c.options?.(failure),
      onError: (step, error) => {
        seen.push([step, error]);
      }
    });
    const expectedResult = c.result?.(failure) ?? {
      content: [{ type: 'text', text: 'unchanged' }]
    };
    server.registerTool(
      'lookup',
      { inputSchema: z.object({ form: z.string().optional() }) },
      // The cases build plain records; the SDK validates the result itself.
      async () =>
        (c.result?.(failure) ?? { content: [{ type: 'text', text: 'unchanged' }] }) as {
          content: [{ type: 'text'; text: string }];
        }
    );
    const client = await connectClient(server);
    const spies = spyConsole();
    const restore = c.inject?.(server, failure);
    try {
      // Sequential on purpose: the second call proves the hook stays suppressed.
      const first = await client.callTool({ name: 'lookup', arguments: c.args ?? {} });
      const second = await client.callTool({ name: 'lookup', arguments: c.args ?? {} });
      for (const result of [first, second]) {
        assert.equal(textOf(result), (expectedResult.content as [{ text: string }])[0].text);
        assert.equal(result.isError, expectedResult.isError);
      }
      await flush();
      await new Promise(resolve => setImmediate(resolve));

      assert.deepEqual(seen, [[c.step, failure]], 'called once across repeated calls');
      assertConsoleSilent(spies);
      assert.equal(events.length, c.recorded ? 2 : 0);
      for (const event of events) {
        assert.equal(event.arguments, null);
        c.check?.(event as unknown as Record<string, unknown>);
      }
      assert.ok(!JSON.stringify(events).includes(marker));
    } finally {
      restore?.();
      for (const spy of spies) spy.mock.restore();
      await client.close();
      await server.close();
    }
  });
}

/**
 * Hook behaviors that must not delay a result, change it, or fall back to the
 * console. The thenables are deliberate: a hook can return one.
 */
const hostileHooks: [string, () => unknown][] = [
  [
    'throws',
    () => {
      throw markerError();
    }
  ],
  ['rejects', () => Promise.reject(markerError())],
  ['never settles', () => new Promise<void>(() => {})],
  [
    'returns a thenable whose then getter throws',
    () =>
      // oxlint-disable-next-line unicorn/no-thenable
      Object.defineProperty({}, 'then', {
        get() {
          throw markerError();
        }
      })
  ],
  [
    'returns a thenable whose then throws',
    () => ({
      // oxlint-disable-next-line unicorn/no-thenable
      then() {
        throw markerError();
      }
    })
  ],
  // oxlint-disable-next-line unicorn/no-thenable
  ['returns a thenable that never settles', () => ({ then() {} })]
];

/** What an uninstrumented server answers for an unknown tool. */
async function unknownToolError() {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  server.registerTool('lookup', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'unchanged' }]
  }));
  const client = await connectClient(server);
  try {
    return await client.callTool({ name: 'missing', arguments: {} }).then(
      () => assert.fail('expected the unknown tool to be rejected'),
      (error: { code?: unknown; message?: unknown }) => ({
        code: error.code,
        message: error.message
      })
    );
  } finally {
    await client.close();
    await server.close();
  }
}

for (const [kind, hook] of hostileHooks) {
  test(`onError ${kind}: contained, not awaited, no console fallback, results unchanged`, async () => {
    const baseline = await unknownToolError();

    let called = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const { server, events, flush } = instrumented({
      resolveIdentity: async () => {
        throw markerError();
      },
      onError: (() => {
        called++;
        return hook();
      }) as InstrumentOptions['onError']
    });
    server.registerTool('lookup', { inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'unchanged' }]
    }));
    const client = await connectClient(server);
    const spies = spyConsole();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the hook delayed the tool result')), 1000);
      });
      const result = await Promise.race([
        client.callTool({ name: 'lookup', arguments: {} }),
        timeout
      ]);
      assert.equal(textOf(result), 'unchanged');

      const failed = await client.callTool({ name: 'missing', arguments: {} }).then(
        () => assert.fail('expected the unknown tool to be rejected'),
        (error: { code?: unknown; message?: unknown }) => ({
          code: error.code,
          message: error.message
        })
      );
      assert.deepEqual(failed, baseline, 'the protocol error reaches the client unchanged');

      await flush();
      // Let rejection handlers and any incorrect raw fallback run.
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(called, 1);
      assert.deepEqual(
        events.map(event => event.success),
        [true, false]
      );
      assertConsoleSilent(spies);
      assert.deepEqual(unhandled, []);
    } finally {
      clearTimeout(timer);
      process.off('unhandledRejection', onUnhandled);
      for (const spy of spies) spy.mock.restore();
      await client.close();
      await server.close();
    }
  });
}

test('onError: suppression spans steps within an instance and resets for a fresh instance', async () => {
  const seen: [string, TelemetryErrorStep][] = [];
  const failingIdentity = {
    resolveIdentity: async () => {
      throw markerError();
    }
  };
  const first = instrumented({
    ...failingIdentity,
    onError: step => void seen.push(['first', step])
  });
  const second = instrumented({
    ...failingIdentity,
    onError: step => void seen.push(['second', step])
  });
  for (const { server } of [first, second]) {
    server.registerTool(
      'lookup',
      { inputSchema: z.object({ form: z.string().optional() }) },
      async () => ({ content: [{ type: 'text', text: 'unchanged' }] })
    );
  }
  const firstClient = await connectClient(first.server);
  const secondClient = await connectClient(second.server);
  const spies = spyConsole();
  const encoder = breakEncoderOn(requestSentinel, markerError());
  try {
    // The first call fails request byte counting, then resolveIdentity.
    await firstClient.callTool({ name: 'lookup', arguments: { form: requestSentinel } });
    await firstClient.callTool({ name: 'lookup', arguments: {} });
    await secondClient.callTool({ name: 'lookup', arguments: {} });
    await Promise.all([first.flush(), second.flush()]);

    assert.deepEqual(seen, [
      ['first', 'request byte count'],
      ['second', 'resolveIdentity']
    ]);
    assertConsoleSilent(spies);
  } finally {
    encoder.mock.restore();
    for (const spy of spies) spy.mock.restore();
    await Promise.all([firstClient.close(), secondClient.close()]);
    await Promise.all([first.server.close(), second.server.close()]);
  }
});

test('onError: not called when telemetry succeeds', async () => {
  let called = 0;
  const { server, events, flush } = instrumented({
    onError: () => {
      called++;
    }
  });
  server.registerTool('lookup', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'unchanged' }]
  }));
  const client = await connectClient(server);
  try {
    assert.equal(textOf(await client.callTool({ name: 'lookup', arguments: {} })), 'unchanged');
    await flush();
    assert.equal(called, 0);
    assert.equal(events.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('no onError: the raw error still goes to console.error once, naming the step', async () => {
  const failure = markerError();
  const { server, events, flush } = instrumented({
    resolveIdentity: async () => {
      throw failure;
    }
  });
  server.registerTool('lookup', { inputSchema: z.object({}) }, async () => ({
    content: [{ type: 'text', text: 'unchanged' }]
  }));
  const client = await connectClient(server);
  const errorLog = mock.method(console, 'error', () => {});
  try {
    await client.callTool({ name: 'lookup', arguments: {} });
    await client.callTool({ name: 'lookup', arguments: {} });
    await flush();
    assert.equal(events.length, 2);
    assert.equal(errorLog.mock.callCount(), 1);
    const [label, error] = errorLog.mock.calls[0].arguments;
    assert.match(String(label), /resolveIdentity failed/);
    assert.equal(error, failure);
  } finally {
    errorLog.mock.restore();
    await client.close();
    await server.close();
  }
});
