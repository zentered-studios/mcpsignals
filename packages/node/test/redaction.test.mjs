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
