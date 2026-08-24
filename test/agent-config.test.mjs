import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../dist/core/config.js';
import { validateAgents, parseInlineAgentSpec } from '../dist/core/agent-config.js';
import { resolveAgent, resolveTaskAgent, snapshotAgents, parseSnapshot } from '../dist/agent/registry.js';

function tempRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-agents-'));
  mkdirSync(join(repo, '.agent-team'), { recursive: true });
  return repo;
}

test('migrates v1 config in memory: roles + models + adapters → agents registry', () => {
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
  const config = loadConfig(repo);
  assert.equal(config.version, 2);
  assert.equal(config.defaultAdapter, undefined);
  // 别名已物化：terra → gpt-5.6-terra
  assert.equal(config.agents['codex-gpt-5-6-terra'].model, 'gpt-5.6-terra');
  assert.equal(config.agents['opencode-z-ai-glm-5-2'].model, 'z-ai/glm-5.2');
  assert.equal(config.agents['opencode-deepseek-v4-flash'].model, 'deepseek/v4-flash');
  // defaultAdapter=codex + adapters.codex.model → defaultAgent
  assert.equal(config.defaultAgent, 'codex-gpt-5-6-terra');
  // roles 指向注册表名
  assert.equal(config.roles.lead, 'codex-gpt-5-6-terra');
  assert.equal(config.roles.reviewer, 'opencode-z-ai-glm-5-2');
  assert.equal(validateAgents(config).ok, true);
});

test('resolves roles through the registry and falls back to defaultAgent', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 2',
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
    'version: 2',
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

test('task.agent resolves with its model (fixes the task.adapter model-drop bug)', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 2',
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
    'version: 2',
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
