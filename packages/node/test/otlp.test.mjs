import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as otel from '@opentelemetry/api';
import { otlpSink } from '../dist/index.mjs';

function makeToolCallEvent(overrides = {}) {
  return {
    event_type: 'tool_call',
    ts: new Date('2026-09-01T23:25:24.000Z'),
    server_name: 's',
    server_version: null,
    tool_name: 'my-tool',
    session_id: null,
    agent_id: null,
    client_name: null,
    client_version: null,
    user_id: null,
    org_id: null,
    duration_ms: 5,
    success: true,
    error_kind: null,
    error_message: null,
    request_bytes: 1,
    response_bytes: 1,
    arguments: null,
    intent: null,
    transport: null,
    ...overrides
  };
}

// The smallest ContextManager the API accepts, backed by AsyncLocalStorage
// like the SDK's own AsyncLocalStorageContextManager. Without a real context
// manager `context.active()` is always ROOT_CONTEXT and the bug cannot show.
function makeAsyncLocalStorageContextManager() {
  const storage = new AsyncLocalStorage();
  return {
    active() {
      return storage.getStore() ?? otel.ROOT_CONTEXT;
    },
    with(context, fn, thisArg, ...args) {
      return storage.run(context, () => fn.call(thisArg, ...args));
    },
    bind(context, target) {
      if (typeof target !== 'function') return target;
      const self = this;
      return function (...args) {
        return self.with(context, () => target.apply(this, args));
      };
    },
    enable() {
      return this;
    },
    disable() {
      storage.disable();
      return this;
    }
  };
}

// Records every startSpan call. Mirrors the API contract the sink relies on:
// Tracer.startSpan(name, options?, context?) falls back to context.active()
// when no context is passed, which is exactly how an ambient parent leaks in.
function makeRecordingTracerProvider() {
  const spans = [];
  const tracer = {
    startSpan(name, options, context) {
      const record = {
        name,
        options,
        context: context ?? otel.context.active(),
        endTime: undefined
      };
      spans.push(record);
      return {
        setAttribute() {
          return this;
        },
        setStatus() {
          return this;
        },
        addEvent() {
          return this;
        },
        end(endTime) {
          record.endTime = endTime;
        }
      };
    },
    startActiveSpan() {
      throw new Error('not used by the sink');
    }
  };
  return {
    spans,
    getTracer() {
      return tracer;
    }
  };
}

const provider = makeRecordingTracerProvider();
assert.equal(otel.trace.setGlobalTracerProvider(provider), true);
assert.equal(otel.context.setGlobalContextManager(makeAsyncLocalStorageContextManager()), true);

after(() => {
  otel.trace.disable();
  otel.context.disable();
});

test('each tool_call span starts from the root context, not the ambient one', async () => {
  const parent = otel.trace.wrapSpanContext({
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: otel.TraceFlags.SAMPLED
  });
  const ambient = otel.trace.setSpan(otel.context.active(), parent);

  const events = [
    makeToolCallEvent({ tool_name: 'first', duration_ms: 5 }),
    makeToolCallEvent({ tool_name: 'second', duration_ms: 7 })
  ];

  // Simulates the size-triggered flush that runs inside a request handler
  // whose HTTP span is active.
  await otel.context.with(ambient, () => otlpSink().write(events));

  assert.equal(provider.spans.length, 2);
  for (const [i, span] of provider.spans.entries()) {
    const event = events[i];
    assert.equal(span.name, `tools/call ${event.tool_name}`);
    assert.equal(
      otel.trace.getSpan(span.context),
      undefined,
      `span ${span.name} inherited the ambient parent span`
    );
    assert.equal(span.options.kind, otel.SpanKind.SERVER);
    assert.equal(span.options.startTime, event.ts);
    assert.deepEqual(span.endTime, new Date(event.ts.getTime() + event.duration_ms));
  }
});
