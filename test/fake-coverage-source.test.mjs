import assert from 'node:assert/strict';
import { test } from 'vitest';
import { FakeBackend } from '../src/agent/fake.ts';

function spec(onEvent) {
  return {
    role: 'worker', cwd: '/repo', prompt: 'test', schema: { type: 'object' }, access: 'read-only',
    timeoutMs: 1_000, staleAfterMs: 1_000, onEvent
  };
}

test('FakeSession skips events that were interrupted before completion begins', async () => {
  const backend = new FakeBackend({ events: [{ type: 'activity' }] });
  const session = await backend.openSession(spec(() => assert.fail('event must not be emitted')));
  await session.interrupt();
  assert.deepEqual(await session.completion(), {
    ok: false, output: null, error: 'interrupted', timedOut: false, stalled: false
  });
});

test('FakeSession normalizes Error and non-Error event callback failures', async () => {
  const errorBackend = new FakeBackend({ events: [{ type: 'activity' }], stepMs: 0 });
  const errorSession = await errorBackend.openSession(spec(() => { throw new Error('event error'); }));
  await assert.rejects(errorSession.completion(), /event error/);

  const stringBackend = new FakeBackend({ events: [{ type: 'activity' }], stepMs: 0 });
  const stringSession = await stringBackend.openSession(spec(() => { throw 'event string'; }));
  await assert.rejects(stringSession.completion(), /event string/);
});
