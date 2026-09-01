import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertSessionCapabilities } from '../src/agent/types.ts';

test('session capability validation rejects unsupported continuation sessions', () => {
  const backend = { id: 'test', capabilities: { maxTurns: true, resumeSession: false } };
  assert.throws(() => assertSessionCapabilities(backend, { resumeSessionId: 'saved' }), /resumeSessionId/);
});
