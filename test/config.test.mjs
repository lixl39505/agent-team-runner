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
  assert.equal(config.defaultAdapter, 'claude');
  assert.equal(config.concurrency, 3);
  assert.deepEqual(config.models, {});
  assert.deepEqual(config.roles, {});
});

test('loadConfig prefers config.yml over config.json', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.json'), JSON.stringify({ concurrency: 9 }), { flag: 'w' });
  writeFileSync(join(repo, '.agent-team', 'config.yml'), 'concurrency: 5\n', { flag: 'w' });
  assert.equal(loadConfig(repo).concurrency, 5);
});

test('loadConfig falls back to legacy config.json', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.json'), JSON.stringify({
    concurrency: 7,
    roles: { lead: 'codex.gpt-5.6-terra' },
    models: { glm52: 'z-ai/glm-5.2' }
  }), { flag: 'w' });
  const config = loadConfig(repo);
  assert.equal(config.concurrency, 7);
  assert.equal(config.roles.lead, 'codex.gpt-5.6-terra');
  assert.equal(config.models.glm52, 'z-ai/glm-5.2');
  // 深合并：未覆盖的键保持默认值
  assert.equal(config.maxReviewCycles, 2);
});

test('loadConfig parses yaml roles and models', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'defaultAdapter: codex',
    'models:',
    '  terra: gpt-5.6-terra',
    'roles:',
    '  lead: codex.terra',
    '  worker: opencode.deepseek/v4-flash',
    'concurrency: 5',
    'verification:',
    '  allowedCommandPrefixes:',
    '    - npm test'
  ].join('\n'), { flag: 'w' });
  const config = loadConfig(repo);
  assert.equal(config.defaultAdapter, 'codex');
  assert.equal(config.concurrency, 5);
  assert.equal(config.roles.lead, 'codex.terra');
  assert.equal(config.models.terra, 'gpt-5.6-terra');
  assert.deepEqual(config.verification.allowedCommandPrefixes, ['npm test']);
});

test('configPath resolves the first existing config file', () => {
  const repo = tempRepo();
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.yml'));
  writeFileSync(join(repo, '.agent-team', 'config.json'), '{}', { flag: 'w' });
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.json'));
  writeFileSync(join(repo, '.agent-team', 'config.yaml'), 'version: 1', { flag: 'w' });
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.yaml'));
  writeFileSync(join(repo, '.agent-team', 'config.yml'), 'version: 1', { flag: 'w' });
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.yml'));
});

test('applyOverrides writes nested paths with typed values', () => {
  const config = applyOverrides(loadConfig(tempRepo()), [
    { key: 'concurrency', value: '5' },
    { key: 'roles.lead', value: 'codex.terra' },
    { key: 'verification.globalCommands', value: '["npm test"]' },
    { key: 'branchPrefix', value: 'team-x' }
  ]);
  assert.equal(config.concurrency, 5);
  assert.equal(config.roles.lead, 'codex.terra');
  assert.deepEqual(config.verification.globalCommands, ['npm test']);
  assert.equal(config.branchPrefix, 'team-x');
});

test('applyOverrides keeps unmodified defaults intact', () => {
  const config = applyOverrides(loadConfig(tempRepo()), [{ key: 'roles.worker', value: 'codex.gpt-5.6-terra' }]);
  assert.equal(config.roles.worker, 'codex.gpt-5.6-terra');
  assert.equal(config.concurrency, 3);
  assert.equal(config.adapters.codex.command, 'codex');
});

test('generated default config yml round-trips through loadConfig', () => {
  const repo = tempRepo();
  initConfig(repo);
  const text = readFileSync(join(repo, '.agent-team', 'config.yml'), 'utf8');
  assert.equal(text.includes('# 角色 → profile'), true);
  const config = loadConfig(repo);
  assert.equal(config.version, 1);
  assert.deepEqual(config.verification.allowedCommandPrefixes.length > 0, true);
  rmSync(repo, { recursive: true, force: true });
});
