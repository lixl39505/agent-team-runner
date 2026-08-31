import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyOverrides, configPath, initConfig, loadConfig } from '../src/core/config.ts';

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
  assert.equal(config.version, 3);
  assert.equal(config.defaultAgent, 'default-claude');
  assert.equal(config.agents['default-claude'].backend, 'claude');
  assert.equal(config.concurrency, 3);
  assert.deepEqual(config.roles, {});
  assert.deepEqual(config.interactionAlert, { background: '#7C3AED', foreground: '#FFFFFF' });
});

test('loadConfig prefers config.yml over config.json', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.json'), JSON.stringify({ version: 3, concurrency: 9, workspace: {}, retry: {}, status: {} }), { flag: 'w' });
  writeFileSync(join(repo, '.agent-team', 'config.yml'), 'version: 3\nconcurrency: 5\nworkspace: {}\nretry: {}\nstatus: {}\n', { flag: 'w' });
  assert.equal(loadConfig(repo).concurrency, 5);
});

test('loadConfig rejects legacy config versions', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.json'), JSON.stringify({
    version: 2,
    concurrency: 7
  }), { flag: 'w' });
  assert.throws(() => loadConfig(repo), /must declare version: 3/);
});

test('loadConfig parses v3 yaml agents and roles', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 3',
    'defaultAgent: default-agent',
    'agents:',
    '  default-agent: { backend: codex, model: gpt-5.6-terra }',
    '  fast-worker: { backend: opencode, model: deepseek/v4-flash }',
    'roles:',
    '  worker: fast-worker',
    'concurrency: 5',
    'workspace: {}',
    'retry: {}',
    'status: {}',
    'verification:',
    '  allowedCommandPrefixes:',
    '    - npm test'
  ].join('\n'), { flag: 'w' });
  const config = loadConfig(repo);
  assert.equal(config.defaultAgent, 'default-agent');
  assert.equal(config.concurrency, 5);
  assert.equal(config.roles.worker, 'fast-worker');
  assert.equal(config.agents['fast-worker'].model, 'deepseek/v4-flash');
  assert.deepEqual(config.verification.allowedCommandPrefixes, ['npm test']);
});

test('configPath resolves the first existing config file', () => {
  const repo = tempRepo();
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.yml'));
  writeFileSync(join(repo, '.agent-team', 'config.json'), JSON.stringify({ version: 3, workspace: {}, retry: {}, status: {} }), { flag: 'w' });
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.json'));
  writeFileSync(join(repo, '.agent-team', 'config.yaml'), 'version: 3\nworkspace: {}\nretry: {}\nstatus: {}\n', { flag: 'w' });
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.yaml'));
  writeFileSync(join(repo, '.agent-team', 'config.yml'), 'version: 3\nworkspace: {}\nretry: {}\nstatus: {}\n', { flag: 'w' });
  assert.equal(configPath(repo), join(repo, '.agent-team', 'config.yml'));
});

test('applyOverrides writes nested paths with typed values', () => {
  const repo = tempRepo();
  initConfig(repo);
  const config = applyOverrides(loadConfig(repo), [
    { key: 'concurrency', value: '5' },
    { key: 'roles.reviewer', value: 'default-agent' },
    { key: 'verification.globalCommands', value: '["npm test"]' },
    { key: 'workspace.branchPrefix', value: 'team-x' }
  ]);
  assert.equal(config.concurrency, 5);
  assert.equal(config.roles.reviewer, 'default-agent');
  assert.deepEqual(config.verification.globalCommands, ['npm test']);
  assert.equal(config.workspace.branchPrefix, 'team-x');
});

test('applyOverrides keeps unmodified defaults intact', () => {
  const repo = tempRepo();
  initConfig(repo);
  const config = applyOverrides(loadConfig(repo), [{ key: 'roles.worker', value: 'codex.gpt-5.6-terra' }]);
  assert.equal(config.roles.worker, 'codex.gpt-5.6-terra');
  assert.equal(config.concurrency, 3);
  assert.deepEqual(config.backends.codex, { nativeWindowsSandbox: 'require' });
});

test('rejects removed Lead and planning configuration keys', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 3',
    'workspace: {}',
    'retry:',
    '  maxPlanAttempts: 2',
    'status: {}'
  ].join('\n'), { flag: 'w' });
  assert.throws(() => loadConfig(repo), /retry\.maxPlanAttempts has been removed/);

  const overrideRepo = tempRepo();
  initConfig(overrideRepo);
  const config = loadConfig(overrideRepo);
  assert.throws(() => applyOverrides(config, [{ key: 'roles.lead', value: 'worker' }]), /removed configuration key/);
  assert.throws(() => applyOverrides(config, [{ key: 'retry.maxPlanAttempts', value: '2' }]), /removed configuration key/);
});

test('validates native Windows sandbox policy', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 3',
    'workspace: {}',
    'retry: {}',
    'status: {}',
    'backends:',
    '  claude:',
    '    nativeWindowsSandbox: allow-degraded'
  ].join('\n'));
  assert.equal(loadConfig(repo).backends.claude.nativeWindowsSandbox, 'allow-degraded');
  writeFileSync(join(repo, '.agent-team', 'config.yml'), 'version: 3\nworkspace: {}\nretry: {}\nstatus: {}\nbackends:\n  claude:\n    nativeWindowsSandbox: unsafe\n');
  assert.throws(() => loadConfig(repo), /nativeWindowsSandbox/);
});

test('loads and validates interaction alert colors', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, '.agent-team', 'config.yml'), [
    'version: 3',
    'workspace: {}',
    'retry: {}',
    'status: {}',
    'interactionAlert:',
    "  background: '#123456'",
    "  foreground: '#ABCDEF'"
  ].join('\n'));
  assert.deepEqual(loadConfig(repo).interactionAlert, { background: '#123456', foreground: '#ABCDEF' });
  assert.throws(() => applyOverrides(loadConfig(repo), [{ key: 'interactionAlert.background', value: 'violet' }]), /#RRGGBB/);
});

test('generated default config yml round-trips through loadConfig', () => {
  const repo = tempRepo();
  initConfig(repo);
  const text = readFileSync(join(repo, '.agent-team', 'config.yml'), 'utf8');
  assert.equal(text.includes('# agent 注册表'), true);
  const config = loadConfig(repo);
  assert.equal(config.version, 3);
  assert.deepEqual(config.verification.allowedCommandPrefixes.length > 0, true);
  rmSync(repo, { recursive: true, force: true });
});
