import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/core/config.ts';
import { validateAgents, parseInlineAgentSpec } from '../src/core/agent-config.ts';
import { resolveAgent, resolveTaskAgent, snapshotAgents, parseSnapshot } from '../src/agent/registry.ts';

function tempRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-agents-'));
  mkdirSync(join(repo, '.agent-team'), { recursive: true });
  return repo;
}

test('rejects legacy v1 config files', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 1',
    'defaultAdapter: codex',
    'models:',
    '  terra: gpt-5.6-terra',
    '  glm52: z-ai/glm-5.2',
    'roles:',
    '  lead: codex.terra',
    '  worker: opencode.deepseek/v4-flash',
    '  reviewer: opencode.glm52',
    'adapters:',
    '  codex:',
    '    command: codex',
    '    model: gpt-5.6-terra'
  ].join('\n'), { flag: 'w' });
  assert.throws(() => loadConfig(repo), /must declare version: 3/);
});

test('resolves roles through the registry and falls back to defaultAgent', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 3',
    'workspace: {}',
    'retry: {}',
    'status: {}',
    'agents:',
    '  lead-agent: { backend: codex, model: gpt-5.6-terra }',
    '  fast-worker: { backend: opencode, model: deepseek/v4-flash }',
    'roles:',
    '  lead: lead-agent',
    '  worker: fast-worker'
  ].join('\n'), { flag: 'w' });
  const config = loadConfig(repo);
  const lead = resolveAgent('lead', config);
  assert.deepEqual(
    { agent: lead.agent, backend: lead.backend, model: lead.model },
    { agent: 'lead-agent', backend: 'codex', model: 'gpt-5.6-terra' }
  );
  // 未配置的角色回退 defaultAgent（自定义注册表时自动取第一个条目）
  const reviewer = resolveAgent('reviewer', config);
  assert.equal(reviewer.agent, 'lead-agent');
  assert.equal(reviewer.backend, 'codex');
  assert.equal(reviewer.source, 'defaultAgent');
});

test('accepts inline backend.model specs and rejects unknown agents', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 3',
    'workspace: {}',
    'retry: {}',
    'status: {}',
    'agents:',
    '  a: { backend: codex }',
    'roles:',
    '  lead: codex.gpt-5.6-terra',
    '  worker: no-such-agent'
  ].join('\n'), { flag: 'w' });
  const config = loadConfig(repo);
  const lead = resolveAgent('lead', config);
  assert.deepEqual(parseInlineAgentSpec('codex.gpt-5.6-terra'), { backend: 'codex', model: 'gpt-5.6-terra' });
  assert.equal(lead.model, 'gpt-5.6-terra');
  assert.throws(() => resolveAgent('worker', config), /unknown agent "no-such-agent"/);
  assert.equal(validateAgents(config).ok, false);
});

test('validates agent auth metadata without accepting secret configuration', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 3',
    'workspace: {}',
    'retry: {}',
    'status: {}',
    'agents:',
    '  valid: { backend: codex, authProfile: work_profile, authIsolation: isolated, baseUrl: https://api.example.com/v1 }',
    '  invalid: { backend: claude, authProfile: bad.profile, authIsolation: per-run, baseUrl: ftp://api.example.com }',
    'defaultAgent: valid'
  ].join('\n'), { flag: 'w' });
  const validation = validateAgents(loadConfig(repo));
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors, [
    'agents.invalid.authProfile: invalid profile name (letters/digits/dash/underscore, no dots)',
    'agents.invalid.authIsolation: must be "shared" or "isolated"',
    'agents.invalid.baseUrl: must be a valid http(s) URL'
  ]);
});

test('task.agent resolves with its model (fixes the task.adapter model-drop bug)', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 3',
    'workspace: {}',
    'retry: {}',
    'status: {}',
    'agents:',
    '  heavy: { backend: codex, model: gpt-5.6-terra }',
    '  light: { backend: claude }',
    'defaultAgent: light'
  ].join('\n'), { flag: 'w' });
  const config = loadConfig(repo);
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
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 3',
    'workspace: {}',
    'retry: {}',
    'status: {}',
    'agents:',
    '  lead-agent: { backend: codex, model: gpt-5.6-terra }',
    'roles:',
    '  lead: lead-agent'
  ].join('\n'), { flag: 'w' });
  const config = loadConfig(repo);
  const snapshot = snapshotAgents(config);
  assert.equal(snapshot.version, 2);
  assert.ok(snapshot.agents['lead-agent']);
  // v2 快照：即使 config 后续删掉 agent，快照仍可解析
  const mutated = { ...config, agents: {}, roles: {} };
  const fromSnapshot = resolveTaskAgent(
    { id: 'T001', title: 't', description: 'd', agent: 'lead-agent', dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [], acceptance: [], verificationCommands: [] },
    mutated,
    JSON.stringify(snapshot)
  );
  assert.equal(fromSnapshot.model, 'gpt-5.6-terra');
  // v1 旧快照形状 {cli, model}
  const legacy = parseSnapshot(JSON.stringify({ lead: { cli: 'codex', model: 'gpt-5.6-terra', source: 'codex.terra' } }));
  assert.equal(legacy.version, 2);
  assert.equal(legacy.roles.lead.backend, 'codex');
  assert.equal(legacy.roles.lead.model, 'gpt-5.6-terra');
});
