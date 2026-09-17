import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createInstrumentedServer, connectClient } from './helpers.mjs';

// `applyRedaction` is not exported, so every case here drives it through
// `instrument()` and reads the recorded `arguments` off the event. The
// default (types only) and the plain allowlist are covered in
// instrument.test.mjs; these are the remaining RedactionConfig branches.

async function recordLookup(instrumentOptions, args = { email: 'jane@example.com', count: 3 }) {
  const { server, events } = createInstrumentedServer(instrumentOptions);
  server.registerTool(
    'lookup',
    { inputSchema: z.object({ email: z.string(), count: z.number() }) },
    async () => ({ content: [{ type: 'text', text: 'ok' }] })
  );
  const client = await connectClient(server);
  await client.callTool({ name: 'lookup', arguments: args });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, 1);
  return events[0].arguments;
}

test('deny alone: every key is type-only, denying one key never reveals the others', async () => {
  const recorded = await recordLookup({ captureArguments: true, redaction: { deny: ['email'] } });
  // Same fail-safe as the Python package: only `allow` ever reveals a value,
  // so a bare `deny` must not turn into "reveal everything not denied".
  assert.deepEqual(recorded, { email: { __type: 'string' }, count: { __type: 'number' } });
  assert.ok(!JSON.stringify(recorded).includes('jane@example.com'));
});

test('deny combined with allow: deny wins for a key listed in both', async () => {
  const recorded = await recordLookup({
    captureArguments: true,
    redaction: { allow: ['email', 'count'], deny: ['email'] }
  });
  assert.deepEqual(recorded, { email: { __type: 'string' }, count: 3 });
});

test('custom redactor: its return value is recorded verbatim and allow/deny are ignored', async () => {
  const seen = [];
  const recorded = await recordLookup({
    captureArguments: true,
    redaction: {
      allow: ['email'],
      deny: ['count'],
      redactor: args => {
        seen.push(args);
        return { keys: Object.keys(args).toSorted(), note: 'from redactor' };
      }
    }
  });
  assert.deepEqual(seen, [{ email: 'jane@example.com', count: 3 }]);
  assert.deepEqual(recorded, { keys: ['count', 'email'], note: 'from redactor' });
});

test('captureArguments false: arguments are null and a configured redactor is never called', async () => {
  let calls = 0;
  const recorded = await recordLookup({
    captureArguments: false,
    redaction: {
      allow: ['email', 'count'],
      redactor: args => {
        calls++;
        return args;
      }
    }
  });
  assert.equal(recorded, null);
  assert.equal(calls, 0, 'capture off must short-circuit before any redaction config runs');
});

// A redactor is a full override: whatever it returns is recorded verbatim.
// Nothing stops it returning a value JSON cannot encode, and `arguments` is
// re-serialized by every sink (`JSON.stringify` in console/d1/bigquery, `pg`'s
// own jsonb encoder in postgres). Before the serializability check in
// `instrument()`, such a value made every one of those sinks throw from inside
// `EventBuffer.writeBatch`, which drops the whole batch — including the
// unrelated events flushed alongside it. The event is kept with `arguments:
// null` instead, the same fallback a throwing redactor already had.

test('redactor returning a circular object: recorded as arguments null, the event survives', async () => {
  const recorded = await recordLookup({
    captureArguments: true,
    redaction: {
      redactor: () => {
        const circular = { name: 'x' };
        circular.self = circular;
        return circular;
      }
    }
  });
  assert.equal(recorded, null);
});

test('redactor returning a BigInt: recorded as arguments null, the event survives', async () => {
  const recorded = await recordLookup({
    captureArguments: true,
    redaction: { redactor: () => ({ total: 10n }) }
  });
  assert.equal(recorded, null);
});

test('an unserializable redactor never costs the other events in the same flush', async () => {
  const events = [];
  const { server } = createInstrumentedServer({
    captureArguments: true,
    bufferSize: 2, // hold both calls, flush them to the sink as one batch
    redaction: {
      redactor: args => {
        if (args.email === 'poison') {
          const circular = {};
          circular.self = circular;
          return circular;
        }
        return { email: 'kept' };
      }
    },
    // Serializes like every real sink does, so this test fails the way a
    // console/d1/bigquery flush failed rather than only pinning the field.
    sinks: [
      {
        write: async batch => {
          JSON.stringify(batch);
          events.push(...batch);
        }
      }
    ]
  });
  server.registerTool(
    'lookup',
    { inputSchema: z.object({ email: z.string(), count: z.number() }) },
    async () => ({ content: [{ type: 'text', text: 'ok' }] })
  );
  const client = await connectClient(server);
  await client.callTool({ name: 'lookup', arguments: { email: 'poison', count: 1 } });
  await client.callTool({ name: 'lookup', arguments: { email: 'fine', count: 2 } });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(events.length, 2, 'both events must reach the sink');
  assert.equal(events[0].arguments, null, 'the unserializable one is recorded as null');
  assert.deepEqual(events[1].arguments, { email: 'kept' }, 'the healthy one is untouched');
});
