import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyOverrides, configPath, initConfig, loadConfig } from '../dist/core/config.js';

function tempRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-config-'));
  mkdirSync(join(repo, '.agent-team'), { recursive: true });
  return repo;
}

test('initConfig generates config.yml and loadConfig reads it', () => {
  const repo = tempRepo();
  const path = initConfig(repo);
  assert.equal(path, join(repo, '.agent-team', 'config.yml'));
  assert.equal(existsSync(path), true);

  const config = loadConfig(repo);
  assert.equal(config.version, 2);
  assert.equal(config.defaultAgent, 'default-claude');
  assert.equal(config.agents['default-claude'].backend, 'claude');
  assert.equal(config.concurrency, 3);
  assert.deepEqual(config.roles, {});
});

test('loadConfig prefers config.yml over config.json', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.json'), JSON.stringify({ concurrency: 9 }), { flag: 'w' });
  writeFileSync(join(repo, '.agent-team', 'config.yml'), 'concurrency: 5\n', { flag: 'w' });
  assert.equal(loadConfig(repo).concurrency, 5);
});

test('loadConfig migrates legacy v1 config.json in memory', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.json'), JSON.stringify({
    concurrency: 7,
    roles: { lead: 'codex.gpt-5.6-terra' },
    models: { glm52: 'z-ai/glm-5.2' }
  }), { flag: 'w' });
  const config = loadConfig(repo);
  assert.equal(config.version, 2);
  assert.equal(config.concurrency, 7);
  // v1 "codex.gpt-5.6-terra" 物化为注册表 agent，roles 指向它
  assert.equal(config.roles.lead, 'codex-gpt-5-6-terra');
  assert.equal(config.agents['codex-gpt-5-6-terra'].model, 'gpt-5.6-terra');
  // 深合并：未覆盖的键保持默认值
  assert.equal(config.maxReviewCycles, 2);
});

test('loadConfig parses v2 yaml agents and roles', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 2',
    'defaultAgent: lead-agent',
    'agents:',
    '  lead-agent: { backend: codex, model: gpt-5.6-terra }',
    '  fast-worker: { backend: opencode, model: deepseek/v4-flash }',
    'roles:',
    '  lead: lead-agent',
    '  worker: fast-worker',
    'concurrency: 5',
    'verification:',
    '  allowedCommandPrefixes:',
    '    - npm test'
  ].join('\n'), { flag: 'w' });
  const config = loadConfig(repo);
  assert.equal(config.defaultAgent, 'lead-agent');
  assert.equal(config.concurrency, 5);
  assert.equal(config.roles.lead, 'lead-agent');
  assert.equal(config.agents['fast-worker'].model, 'deepseek/v4-flash');
  assert.deepEqual(config.verification.allowedCommandPrefixes, ['npm test']);
});

test('configPath resolves the first existing config file', () => {
  const repo = tempRepo();
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.yml'));
  writeFileSync(join(repo, '.agent-team', 'config.json'), '{}', { flag: 'w' });
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.json'));
  writeFileSync(join(repo, '.agent-team', 'config.yaml'), 'version: 2', { flag: 'w' });
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.yaml'));
  writeFileSync(join(repo, '.agent-team', 'config.yml'), 'version: 2', { flag: 'w' });
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.yml'));
});

test('applyOverrides writes nested paths with typed values', () => {
  const config = applyOverrides(loadConfig(tempRepo()), [
    { key: 'concurrency', value: '5' },
    { key: 'roles.lead', value: 'lead-agent' },
    { key: 'verification.globalCommands', value: '["npm test"]' },
    { key: 'branchPrefix', value: 'team-x' }
  ]);
  assert.equal(config.concurrency, 5);
  assert.equal(config.roles.lead, 'lead-agent');
  assert.deepEqual(config.verification.globalCommands, ['npm test']);
  assert.equal(config.branchPrefix, 'team-x');
});

test('applyOverrides keeps unmodified defaults intact', () => {
  const config = applyOverrides(loadConfig(tempRepo()), [{ key: 'roles.worker', value: 'codex.gpt-5.6-terra' }]);
  assert.equal(config.roles.worker, 'codex.gpt-5.6-terra');
  assert.equal(config.concurrency, 3);
  assert.deepEqual(config.backends.codex, {});
});

test('generated default config yml round-trips through loadConfig', () => {
  const repo = tempRepo();
  initConfig(repo);
  const text = readFileSync(join(repo, '.agent-team', 'config.yml'), 'utf8');
  assert.equal(text.includes('# agent 注册表'), true);
  const config = loadConfig(repo);
  assert.equal(config.version, 2);
  assert.deepEqual(config.verification.allowedCommandPrefixes.length > 0, true);
  rmSync(repo, { recursive: true, force: true });
});
