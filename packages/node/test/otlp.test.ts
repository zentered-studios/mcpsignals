import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as otel from '@opentelemetry/api';
import { otlpSink, type ToolCallEvent } from 'mcpsignals';

function makeToolCallEvent(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
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
// Cast to otel.ContextManager at the registration call below rather than
// implementing its full (generic) surface here.
function makeAsyncLocalStorageContextManager() {
  const storage = new AsyncLocalStorage<otel.Context>();
  const manager = {
    active() {
      return storage.getStore() ?? otel.ROOT_CONTEXT;
    },
    with<F extends (...args: unknown[]) => unknown>(
      context: otel.Context,
      fn: F,
      thisArg?: unknown,
      ...args: unknown[]
    ) {
      return storage.run(context, () => fn.apply(thisArg, args));
    },
    bind(context: otel.Context, target: unknown) {
      if (typeof target !== 'function') return target;
      return function (this: unknown, ...args: unknown[]) {
        return manager.with(context, () => target.apply(this, args));
      };
    },
    enable() {
      return manager;
    },
    disable() {
      storage.disable();
      return manager;
    }
  };
  return manager;
}

interface RecordedSpan {
  name: string;
  options: otel.SpanOptions;
  context: otel.Context;
  endTime: otel.TimeInput | undefined;
  // Attributes set after creation, plus the status and events, so the
  // tests below can assert the full span the sink produces rather than
  // only its constructor arguments.
  setAttributes: Record<string, unknown>;
  status: otel.SpanStatus | undefined;
  events: { name: string; attributes: unknown }[];
}

// Records every startSpan call. Mirrors the API contract the sink relies on:
// Tracer.startSpan(name, options?, context?) falls back to context.active()
// when no context is passed, which is exactly how an ambient parent leaks in.
// Cast to otel.TracerProvider at the registration call below rather than
// implementing its full surface here.
function makeRecordingTracerProvider() {
  const spans: RecordedSpan[] = [];
  const tracer = {
    startSpan(name: string, options: otel.SpanOptions, context?: otel.Context) {
      const record: RecordedSpan = {
        name,
        options,
        context: context ?? otel.context.active(),
        endTime: undefined,
        setAttributes: {},
        status: undefined,
        events: []
      };
      spans.push(record);
      return {
        setAttribute(key: string, value: unknown) {
          record.setAttributes[key] = value;
          return this;
        },
        setStatus(status: otel.SpanStatus) {
          record.status = status;
          return this;
        },
        addEvent(eventName: string, attributes: unknown) {
          record.events.push({ name: eventName, attributes });
          return this;
        },
        end(endTime: otel.TimeInput) {
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
assert.equal(otel.trace.setGlobalTracerProvider(provider as unknown as otel.TracerProvider), true);
assert.equal(
  otel.context.setGlobalContextManager(
    makeAsyncLocalStorageContextManager() as unknown as otel.ContextManager
  ),
  true
);

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

// The attribute mapping is the sink's whole product, and every `gen_ai.*` /
// `mcp.*` name below is Development status in the OTel GenAI semantic
// conventions, so it moves. These tests pin what we emit today; a
// convention change should make them fail loudly rather than drift silently.

async function spansFor(events: ToolCallEvent[]) {
  const before = provider.spans.length;
  await otlpSink().write(events);
  return provider.spans.slice(before);
}

test('a fully populated event maps to the documented attribute set', async () => {
  const [span] = await spansFor([
    makeToolCallEvent({
      tool_name: 'search',
      server_name: 'my-server',
      server_version: '1.2.3',
      session_id: 'sess-1',
      agent_id: 'agent-1',
      client_name: 'my-client',
      client_version: '9.9',
      user_id: 'user-1',
      org_id: 'org-1',
      transport: 'http',
      intent: 'user asked',
      arguments: { a: 1 },
      request_bytes: 11,
      response_bytes: 22
    })
  ]);

  assert.deepEqual(span.options.attributes, {
    'mcp.method.name': 'tools/call',
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': 'search',
    'network.transport': 'tcp',
    'network.protocol.name': 'http',
    'mcp.session.id': 'sess-1',
    'gen_ai.tool.call.arguments': '{"a":1}',
    'mcpsignals.intent': 'user asked',
    'mcpsignals.agent.id': 'agent-1',
    'enduser.id': 'user-1',
    'mcpsignals.org.id': 'org-1',
    'mcpsignals.server.name': 'my-server',
    'mcpsignals.server.version': '1.2.3',
    'mcpsignals.client.name': 'my-client',
    'mcpsignals.client.version': '9.9',
    'mcpsignals.transport': 'http',
    'mcpsignals.request.bytes': 11,
    'mcpsignals.response.bytes': 22
  });
});

test('null fields are omitted rather than emitted as null attributes', async () => {
  // A null attribute value is not valid in OTel and an exporter may drop the
  // whole span over one. The default event has null everywhere optional.
  const [span] = await spansFor([makeToolCallEvent()]);

  const attributes = span.options.attributes ?? {};
  assert.deepEqual(Object.keys(attributes).toSorted(), [
    'gen_ai.operation.name',
    'gen_ai.tool.name',
    'mcp.method.name',
    'mcpsignals.request.bytes',
    'mcpsignals.response.bytes',
    'mcpsignals.server.name'
  ]);
  for (const value of Object.values(attributes)) {
    assert.notEqual(value, null);
  }
});

test('stdio maps to network.transport pipe, with no network.protocol.name', async () => {
  const [span] = await spansFor([makeToolCallEvent({ transport: 'stdio' })]);

  assert.equal(span.options.attributes?.['network.transport'], 'pipe');
  assert.equal(span.options.attributes?.['network.protocol.name'], undefined);
  assert.equal(span.options.attributes?.['mcpsignals.transport'], 'stdio');
});

test('a successful call gets status OK and no exception event', async () => {
  const [span] = await spansFor([makeToolCallEvent({ success: true })]);

  assert.equal(span.status?.code, otel.SpanStatusCode.OK);
  assert.deepEqual(span.events, []);
  assert.deepEqual(span.setAttributes, {});
});

test('a failed call gets status ERROR, error.type and an exception event', async () => {
  const [span] = await spansFor([
    makeToolCallEvent({
      success: false,
      error_kind: 'not_found',
      error_message: 'record with that id was not found'
    })
  ]);

  assert.equal(span.status?.code, otel.SpanStatusCode.ERROR);
  assert.equal(span.status?.message, 'record with that id was not found');
  assert.equal(span.setAttributes['error.type'], 'tool_error');
  assert.equal(span.options.attributes?.['mcpsignals.error.kind'], 'not_found');
  assert.deepEqual(span.events, [
    {
      name: 'exception',
      attributes: { 'exception.message': 'record with that id was not found' }
    }
  ]);
});

test('a failure with no message still gets status ERROR but no exception event', async () => {
  const [span] = await spansFor([
    makeToolCallEvent({ success: false, error_kind: null, error_message: null })
  ]);

  assert.equal(span.status?.code, otel.SpanStatusCode.ERROR);
  assert.equal(span.status?.message, undefined);
  assert.deepEqual(span.events, [], 'no message means nothing to record as an exception');
});

test('span start and end come from the event, not from flush time', async () => {
  // Events are written in batches, potentially long after the call happened.
  const ts = new Date('2026-09-01T23:25:24.000Z');
  const [span] = await spansFor([makeToolCallEvent({ ts, duration_ms: 1234 })]);

  assert.equal(span.options.startTime, ts);
  assert.deepEqual(span.endTime, new Date(ts.getTime() + 1234));
});
