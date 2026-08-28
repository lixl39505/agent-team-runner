import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindingsForRun, checkAgentAvailability, probeAll } from '../src/core/preflight.ts';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { FakeBackend } from '../src/agent/fake.ts';

function input(platform) {
  const claude = new FakeBackend({}, [], 'claude');
  claude.checkPlatform = async () => platform;
  return {
    config: { ...DEFAULT_CONFIG, workspace: { ...DEFAULT_CONFIG.workspace, stateDir: mkdtempSync(join(tmpdir(), 'agent-team-preflight-platform-')) } },
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

test('preflight probes an explicit model when enumeration fails', async () => {
  const value = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  value.bindings = [{ agent: 'custom', backend: 'claude', model: 'custom-model', source: 'test' }];
  const probes = [];
  value.backends.claude.listModels = async () => { throw new Error('provider unavailable'); };
  value.backends.claude.probe = async (model) => {
    probes.push(model);
    return { ok: true, latencyMs: 1 };
  };

  const result = await checkAgentAvailability(value);

  assert.equal(result.ok, true);
  assert.deepEqual(probes, ['custom-model']);
  assert.match(result.warnings.join('\n'), /model enumeration failed/);
  assert.match(result.warnings.join('\n'), /live probe succeeded/);
});

test('preflight rejects an unavailable default model', async () => {
  const value = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  const probes = [];
  value.backends.claude.probe = async (model) => {
    probes.push(model);
    return { ok: false, error: 'authentication failed', latencyMs: 1 };
  };

  const result = await checkAgentAvailability(value);

  assert.equal(result.ok, false);
  assert.deepEqual(probes, [undefined]);
  assert.match(result.errors[0], /default model is not available.*authentication failed/);
});

test('doctor probe verifies the backend default model', async () => {
  const value = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  const probes = [];
  value.backends.claude.probe = async (model) => {
    probes.push(model);
    return { ok: false, error: 'default unavailable', latencyMs: 1 };
  };

  const result = await probeAll(value);

  assert.deepEqual(probes, [undefined]);
  assert.deepEqual(result, [{ agent: 'test', backend: 'claude', ok: false, error: 'default unavailable', latencyMs: 1 }]);
});

test('run bindings include manifest task-level agents', () => {
  const config = {
    ...DEFAULT_CONFIG,
    agents: {
      'default-claude': { backend: 'claude' },
      specialist: { backend: 'codex', model: 'gpt-5.6-terra' }
    }
  };
  const bindings = bindingsForRun(config, null, JSON.stringify({ tasks: [{ agent: 'specialist' }] }));

  assert.equal(bindings.some((binding) => binding.agent === 'specialist' && binding.backend === 'codex'), true);
});

test('preflight rejects maxTurns when the backend does not support it', async () => {
  const value = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  value.bindings = [{ agent: 'limited', backend: 'claude', maxTurns: 10, source: 'test' }];
  value.backends.claude.capabilities = { maxTurns: false, resumeSession: false };

  const result = await checkAgentAvailability(value);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['agent "limited" configures maxTurns, but backend "claude" does not support it']);
});

test('preflight reports unavailable backends without optional discovery detail', async () => {
  const value = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  value.backends.claude.discover = async () => ({ backend: 'claude', installed: false });

  const result = await checkAgentAvailability(value);

  assert.deepEqual(result.errors, ['backend "claude" is not available locally; install it or choose another agent']);
});

test('preflight suppresses duplicate unsupported maxTurns errors', async () => {
  const value = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  value.bindings = [
    { agent: 'limited', backend: 'claude', maxTurns: 10, source: 'test' },
    { agent: 'limited', backend: 'claude', maxTurns: 20, source: 'test' }
  ];
  value.backends.claude.capabilities = { maxTurns: false, resumeSession: false };

  const result = await checkAgentAvailability(value);

  assert.deepEqual(result.errors, ['agent "limited" configures maxTurns, but backend "claude" does not support it']);
});

test('preflight stringifies non-Error discovery and model enumeration failures', async () => {
  const discoveryFailure = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  discoveryFailure.backends.claude.discover = async () => { throw 'not executable'; };

  const discoveryResult = await checkAgentAvailability(discoveryFailure);

  assert.deepEqual(discoveryResult.errors, ['backend "claude" discovery failed: not executable']);

  const enumerationFailure = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  enumerationFailure.bindings = [{ agent: 'custom', backend: 'claude', model: 'custom-model', source: 'test' }];
  enumerationFailure.backends.claude.listModels = async () => { throw 'provider unavailable'; };

  const enumerationResult = await checkAgentAvailability(enumerationFailure);

  assert.match(enumerationResult.warnings.join('\n'), /model enumeration failed \(provider unavailable\)/);
});

test('preflight handles explicit models missing from the model list', async () => {
  const unavailable = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  unavailable.bindings = [{ agent: 'custom', backend: 'claude', model: 'custom-model', source: 'test' }];
  unavailable.backends.claude.probe = async () => ({ ok: false, latencyMs: 1 });

  const unavailableResult = await checkAgentAvailability(unavailable);

  assert.deepEqual(unavailableResult.errors, ['agent "custom": model "custom-model" is not available on backend "claude"']);

  const available = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  available.bindings = [{ agent: 'custom', backend: 'claude', model: 'custom-model', source: 'test' }];

  const availableResult = await checkAgentAvailability(available);

  assert.match(availableResult.warnings.join('\n'), /not in the backend's model list but a live probe succeeded/);
});

test('preflight stringifies a non-Error probe crash', async () => {
  const value = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  value.backends.claude.probe = async () => { throw 'probe process exited'; };

  const result = await checkAgentAvailability(value);

  assert.deepEqual(result.errors, ['agent "test": default model is not available on backend "claude": probe process exited']);
  assert.deepEqual(result.warnings, ['probe on claude/default crashed: probe process exited']);
});

test('doctor probe reports explicit model successes and non-Error crashes', async () => {
  const value = input({ ok: true, degraded: false, detail: 'sandbox ready' });
  value.bindings = [
    { agent: 'healthy', backend: 'claude', model: 'healthy-model', source: 'test' },
    { agent: 'broken', backend: 'claude', model: 'broken-model', source: 'test' }
  ];
  value.backends.claude.probe = async (model) => {
    if (model === 'healthy-model') return { ok: true, latencyMs: 1 };
    throw 'probe process exited';
  };

  const result = await probeAll(value);

  assert.deepEqual(result, [
    { agent: 'healthy', backend: 'claude', model: 'healthy-model', ok: true, latencyMs: 1 },
    { agent: 'broken', backend: 'claude', model: 'broken-model', ok: false, error: 'probe process exited' }
  ]);
});
