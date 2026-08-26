import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkAgentAvailability } from '../dist/core/preflight.js';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { FakeBackend } from '../dist/agent/fake.js';

function input(platform) {
  const claude = new FakeBackend({}, [], 'claude');
  claude.checkPlatform = async () => platform;
  return {
    config: { ...DEFAULT_CONFIG, stateDir: mkdtempSync(join(tmpdir(), 'agent-team-preflight-platform-')) },
    backends: { claude, codex: new FakeBackend({}, [], 'codex'), opencode: new FakeBackend({}, [], 'opencode') },
    bindings: [{ agent: 'test', backend: 'claude', source: 'test' }]
  };
}

test('preflight fails closed when a required platform sandbox is unavailable', async () => {
  const result = await checkAgentAvailability(input({ ok: false, degraded: false, detail: 'sandbox is not configured' }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['backend "claude" platform check failed: sandbox is not configured']);
});

test('preflight surfaces explicit sandbox degradation as a warning', async () => {
  const result = await checkAgentAvailability(input({ ok: true, degraded: true, detail: 'user opted into host permissions' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, ['backend "claude" platform isolation is degraded: user opted into host permissions']);
});
