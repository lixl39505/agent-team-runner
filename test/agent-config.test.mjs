import { test } from 'vitest';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/core/defaults.ts';
import { validateAgents, parseInlineAgentSpec } from '../src/core/agent-config.ts';
import { resolveAgent, resolveTaskAgent, snapshotAgents, parseSnapshot } from '../src/agent/registry.ts';

function runnerConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace },
    backends: { ...DEFAULT_CONFIG.backends },
    agents: { ...DEFAULT_CONFIG.agents },
    roles: { ...DEFAULT_CONFIG.roles },
    ...overrides
  };
}

test('resolves roles through the registry and falls back to defaultAgent', () => {
  const config = runnerConfig({
    defaultAgent: 'default-agent',
    agents: {
      'default-agent': { backend: 'codex', model: 'gpt-5.6-terra' },
      'fast-worker': { backend: 'opencode', model: 'deepseek/v4-flash' }
    },
    roles: { worker: 'fast-worker' }
  });
  const worker = resolveAgent('worker', config);
  assert.deepEqual(
    { agent: worker.agent, backend: worker.backend, model: worker.model },
    { agent: 'fast-worker', backend: 'opencode', model: 'deepseek/v4-flash' }
  );
  // 未配置的角色回退 defaultAgent（自定义注册表时自动取第一个条目）
  const reviewer = resolveAgent('reviewer', config);
  assert.equal(reviewer.agent, 'default-agent');
  assert.equal(reviewer.backend, 'codex');
  assert.equal(reviewer.source, 'defaultAgent');
});

test('accepts inline backend.model specs and rejects unknown agents', () => {
  const config = runnerConfig({
    defaultAgent: 'a',
    agents: { a: { backend: 'codex' } },
    roles: { reviewer: 'codex.gpt-5.6-terra', worker: 'no-such-agent' }
  });
  const reviewer = resolveAgent('reviewer', config);
  assert.deepEqual(parseInlineAgentSpec('codex.gpt-5.6-terra'), { backend: 'codex', model: 'gpt-5.6-terra' });
  assert.equal(reviewer.model, 'gpt-5.6-terra');
  assert.throws(() => resolveAgent('worker', config), /unknown agent "no-such-agent"/);
  assert.equal(validateAgents(config).ok, false);
});

test('validates agent auth metadata without accepting secret configuration', () => {
  const validation = validateAgents(runnerConfig({
    defaultAgent: 'valid',
    agents: {
      valid: { backend: 'codex', authProfile: 'work_profile', authIsolation: 'isolated', baseUrl: 'https://api.example.com/v1' },
      invalid: { backend: 'claude', authProfile: 'bad.profile', authIsolation: 'per-run', baseUrl: 'ftp://api.example.com' }
    }
  }));
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors, [
    'agents.invalid.authProfile: invalid profile name (letters/digits/dash/underscore, no dots)',
    'agents.invalid.authIsolation: must be "shared" or "isolated"',
    'agents.invalid.baseUrl: must be a valid http(s) URL'
  ]);
});

test('task.agent resolves with its model (fixes the task.adapter model-drop bug)', () => {
  const config = runnerConfig({
    defaultAgent: 'light',
    agents: { heavy: { backend: 'codex', model: 'gpt-5.6-terra' }, light: { backend: 'claude' } }
  });
  const binding = resolveTaskAgent(
    { id: 'T001', title: 't', description: 'd', agent: 'heavy', dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [], acceptance: [], verificationCommands: [] },
    config,
    null
  );
  assert.equal(binding.model, 'gpt-5.6-terra');
  assert.equal(binding.source, 'task:heavy');
  // 无 task.agent → worker 角色回退 defaultAgent
  const fallback = resolveTaskAgent(
    { id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [], acceptance: [], verificationCommands: [] },
    config,
    null
  );
  assert.equal(fallback.agent, 'light');
  assert.equal(fallback.backend, 'claude');
});

test('snapshot keeps runs hermetic and parses legacy v1 snapshots', () => {
  const config = runnerConfig({
    defaultAgent: 'default-agent',
    agents: { 'default-agent': { backend: 'codex', model: 'gpt-5.6-terra' } }
  });
  const snapshot = snapshotAgents(config);
  assert.equal(snapshot.version, 2);
  assert.ok(snapshot.agents['default-agent']);
  // v2 快照：即使 config 后续删掉 agent，快照仍可解析
  const mutated = { ...config, agents: {}, roles: {} };
  const fromSnapshot = resolveTaskAgent(
    { id: 'T001', title: 't', description: 'd', agent: 'default-agent', dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [], acceptance: [], verificationCommands: [] },
    mutated,
    JSON.stringify(snapshot)
  );
  assert.equal(fromSnapshot.model, 'gpt-5.6-terra');
  // v1 旧快照形状 {cli, model}
  const legacy = parseSnapshot(JSON.stringify({ worker: { cli: 'codex', model: 'gpt-5.6-terra', source: 'codex.terra' } }));
  assert.equal(legacy.version, 2);
  assert.equal(legacy.roles.worker.backend, 'codex');
  assert.equal(legacy.roles.worker.model, 'gpt-5.6-terra');
});

test('allows an intentionally unset role binding', () => {
  const result = validateAgents({
    defaultAgent: 'default',
    agents: { default: { backend: 'claude' } },
    roles: { worker: 'default', reviewer: '' }
  });

  assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
});

test('rejects malformed agent base URLs', () => {
  const result = validateAgents({
    defaultAgent: 'default',
    agents: { default: { backend: 'claude', baseUrl: 'https://[' } },
    roles: {}
  });

  assert.deepEqual(result.errors, ['agents.default.baseUrl: must be a valid http(s) URL']);
});
