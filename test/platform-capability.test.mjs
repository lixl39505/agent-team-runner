import test from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedNativeWindowsSandbox } from '../dist/agent/platform.js';
import { codexWindowsSandboxCapability } from '../dist/agent/codex/app-server.js';

test('native Windows backends fail closed until degradation is explicitly allowed', () => {
  const required = unsupportedNativeWindowsSandbox('claude', 'require', 'win32');
  assert.equal(required.ok, false);
  assert.match(required.detail, /WSL2/);

  const allowed = unsupportedNativeWindowsSandbox('opencode', 'allow-degraded', 'win32');
  assert.equal(allowed.ok, true);
  assert.equal(allowed.degraded, true);
});

test('Codex Windows readiness maps to require or explicit degradation', () => {
  assert.deepEqual(codexWindowsSandboxCapability('ready', 'require', 'win32'), {
    ok: true, degraded: false, detail: 'Codex native Windows sandbox is ready'
  });
  assert.equal(codexWindowsSandboxCapability('notConfigured', 'require', 'win32').ok, false);
  const degraded = codexWindowsSandboxCapability('updateRequired', 'allow-degraded', 'win32');
  assert.equal(degraded.ok, true);
  assert.equal(degraded.degraded, true);
  assert.equal(codexWindowsSandboxCapability('notConfigured', 'require', 'linux').ok, true);
});
