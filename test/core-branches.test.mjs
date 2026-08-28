import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyOverrides, DEFAULT_CONFIG, initConfig, loadConfig } from '../src/core/config.ts';
import { agentList, backendCommand, isBackendId, isValidAgentName, migrateV1Fields, parseInlineAgentSpec, validateAgents } from '../src/core/agent-config.ts';
import { checkPaths, globMatch, patternMatches } from '../src/core/path-policy.ts';
import { validateIntegrationResult, validateLeadResult, validateReviewResult, validateTaskGraph, validateWorkerResult } from '../src/core/validation.ts';
import { ProbeCache } from '../src/core/probe-cache.ts';
import { assertAllowedCommand, splitCommand } from '../src/core/shell.ts';
import { bindingsForRun, checkAgentAvailability, probeAll } from '../src/core/preflight.ts';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function repo() {
  const root = tempDir('agent-team-core-');
  mkdirSync(join(root, '.agent-team'), { recursive: true });
  return root;
}

function task(id = 'T001', extra = {}) {
  return {
    id,
    title: id,
    description: 'work',
    dependsOn: [],
    allowedPaths: [`src/${id}/**`],
    blockedPaths: [],
    acceptance: ['complete'],
    verificationCommands: [],
    ...extra
  };
}

function config(stateDir = tempDir('agent-team-preflight-')) {
  return { ...DEFAULT_CONFIG, stateDir };
}

function backend(id, overrides = {}) {
  return {
    id,
    capabilities: { maxTurns: true, resumeSession: true },
    discover: async () => ({ backend: id, installed: true, version: 'test-1', authed: true }),
    listModels: async () => [],
    probe: async () => ({ ok: true, latencyMs: 1 }),
    ...overrides
  };
}

test('config rejects non-mapping input and preserves existing config during init', () => {
  const root = repo();
  const path = join(root, '.agent-team', 'config.yml');
  writeFileSync(path, 'not-a-mapping\n');
  assert.throws(() => loadConfig(root), /empty or not a mapping/);

  writeFileSync(path, 'concurrency: 8\n');
  assert.equal(initConfig(root), path);
  assert.equal(readFileSync(path, 'utf8'), 'concurrency: 8\n');
  assert.equal(loadConfig(root).concurrency, 8);
});

test('config resolves absolute paths and applies string fallback overrides', () => {
  const root = repo();
  writeFileSync(join(root, '.agent-team', 'config.json'), JSON.stringify({
    repoRoot: '.', stateDir: '/tmp/agent-team-state', worktreesDir: 'trees'
  }));
  const loaded = loadConfig(root);
  assert.equal(loaded.stateDir, '/tmp/agent-team-state');
  assert.equal(loaded.worktreesDir, join(root, 'trees'));
  const overridden = applyOverrides(loaded, [{ key: 'new.branch.value', value: 'not-json' }]);
  assert.equal(overridden.new.branch.value, 'not-json');
  assert.throws(() => applyOverrides(loaded, [{ key: '...', value: 'x' }]), /empty key/);
});

test('agent config validates malformed registry entries and v1 edge cases', () => {
  const invalid = {
    ...DEFAULT_CONFIG,
    defaultAgent: 'missing',
    agents: { 'bad.name': { backend: 'unknown' } },
    roles: { lead: 'codex.model', worker: 'nope' }
  };
  const result = validateAgents(invalid);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 4);
  assert.match(result.errors.join('\n'), /invalid agent name/);
  assert.match(result.errors.join('\n'), /unknown backend/);
  assert.match(result.errors.join('\n'), /defaultAgent/);
  assert.match(result.warnings[0], /inline spec/);
  assert.deepEqual(agentList({ ...DEFAULT_CONFIG, agents: { a: { backend: 'codex', model: 'm' } } }), [{ name: 'a', backend: 'codex', model: 'm' }]);
  assert.equal(backendCommand({ ...DEFAULT_CONFIG, backends: { ...DEFAULT_CONFIG.backends, codex: { command: '  custom-codex  ' } } }, 'codex'), 'custom-codex');
  assert.equal(backendCommand(DEFAULT_CONFIG, 'claude'), 'claude');
  assert.equal(isBackendId('codex'), true);
  assert.equal(isBackendId('other'), false);
  assert.equal(isValidAgentName('_bad'), false);
  assert.equal(parseInlineAgentSpec('codex.'), null);
  assert.equal(parseInlineAgentSpec('other.model'), null);
  assert.equal(migrateV1Fields({ version: 2, adapters: {} }), null);
  const migrated = migrateV1Fields({ defaultAdapter: 'invalid', roles: { lead: 'bad.spec', worker: 'codex.' } });
  assert.equal(migrated.defaultAgent, 'default-claude');
  assert.deepEqual(migrated.roles, { worker: 'default-codex' });
});

test('path policy normalizes globs and identifies invalid and blocked files', () => {
  assert.equal(globMatch('src/a.ts', './src/?\.ts'), true);
  assert.equal(globMatch('src\\deep\\a.ts', 'src/**/a.ts'), true);
  assert.equal(patternMatches('docs', 'docs'), true);
  assert.equal(patternMatches('docs/readme', 'docs'), true);
  assert.equal(patternMatches('docs/readme.md', 'docs.md'), false);
  assert.deepEqual(
    checkPaths(['src/ok.ts', 'secret/key.ts', 'other.ts'], ['src', 'secret/**'], ['secret']),
    { ok: false, invalid: ['other.ts'], blocked: ['secret/key.ts'] }
  );
});

test('validation rejects malformed manifests and result payloads', () => {
  assert.throws(() => validateLeadResult(null), /must be an object/);
  assert.throws(() => validateLeadResult({ version: 1, title: 'x', summary: 'x', tasks: [task('T001', { dependsOn: ['NOPE'] })] }), /unknown task/);
  assert.throws(() => validateLeadResult({ version: 1, title: 'x', summary: 'x', tasks: [task('T001'), task('T001')] }), /Duplicate/);
  assert.throws(() => validateLeadResult({ version: 1, title: 'x', summary: 'x', tasks: [task('T001', { dependsOn: ['T001'] })] }), /cannot depend on itself/);
  assert.throws(() => validateLeadResult({ version: 1, title: 'x', summary: 'x', tasks: [task('T001', { allowedPaths: [] })] }), /no allowed paths/);
  assert.throws(() => validateLeadResult({ version: 1, title: 'x', summary: 'x', tasks: [task('T001', { verificationCommands: [1] })] }), /string array/);
  assert.throws(() => validateTaskGraph([task('T001', { dependsOn: ['T002'] }), task('T002', { dependsOn: ['T001'] })]), /cycle/);
  assert.throws(() => validateWorkerResult({ status: 'unknown' }), /Invalid worker status/);
  assert.throws(() => validateWorkerResult({ status: 'completed', testsRun: 'no' }), /testsRun must be a string array/);
  assert.throws(() => validateReviewResult({ decision: 'approved', findings: [{ severity: 'urgent' }] }), /Invalid finding severity/);
  assert.throws(() => validateIntegrationResult({ status: 'blocked', documentationUpdated: [1] }), /documentationUpdated must be a string array/);
  assert.deepEqual(validateReviewResult({ decision: 'approved', findings: [], requiredChanges: [] }), {
    decision: 'approved', summary: '', findings: [], requiredChanges: []
  });
});

test('probe cache treats missing fields as an empty cache and ignores persistence failures', () => {
  const dir = tempDir('agent-team-cache-');
  const path = join(dir, 'cache.json');
  writeFileSync(path, '{}');
  assert.equal(new ProbeCache(path).get('x', 'y', undefined), null);

  const unwritable = new ProbeCache('/dev/null/preflight-cache.json');
  assert.doesNotThrow(() => unwritable.set('codex', 'model', undefined, { ok: false, error: 'no access', latencyMs: 0, checkedAt: Date.now() }));
  assert.equal(unwritable.get('codex', 'model', undefined)?.error, 'no access');
  const future = new ProbeCache(join(dir, 'future.json'), 1);
  future.set('codex', 'model', undefined, { ok: true, latencyMs: 0, checkedAt: Date.now() + 60_000 });
  assert.equal(future.get('codex', 'model', undefined)?.ok, true);
  assert.equal(existsSync(join(dir, 'future.json')), true);
});

test('shell parsing rejects empty, dangling, and unsafe allowlist commands', () => {
  assert.throws(() => splitCommand('   '), /Command is empty/);
  assert.throws(() => splitCommand('node "unterminated'), /Unclosed quote/);
  assert.throws(() => splitCommand('node trailing\\'), /Unclosed quote or escape/);
  assert.deepEqual(splitCommand('node "two words" \\"'), ['node', 'two words', '"']);
  assert.throws(() => assertAllowedCommand('npm test', ['npm test && rm -rf /']), /Unsafe shell syntax/);
  assert.throws(() => assertAllowedCommand('git status --help', ['git status']), /Unsafe command arguments/);
  assert.throws(() => assertAllowedCommand('make test --eval=x', ['make test']), /Unsafe command arguments/);
});

test('preflight reports discovery, authentication, and probe failures without real backends', async () => {
  const stateDir = tempDir('agent-team-preflight-');
  const claude = backend('claude', {
    discover: async () => ({ backend: 'claude', installed: false, detail: 'not installed' })
  });
  const codex = backend('codex', {
    discover: async () => ({ backend: 'codex', installed: true, version: 'test-1', authed: false }),
    listModels: async () => [{ id: 'listed' }]
  });
  const result = await checkAgentAvailability({
    config: config(stateDir),
    backends: { claude, codex, opencode: backend('opencode') },
    bindings: [
      { agent: 'missing-cli', backend: 'claude', source: 'test' },
      { agent: 'unauthenticated', backend: 'codex', model: 'listed', source: 'test' },
      { agent: 'unregistered', backend: 'opencode', source: 'test' }
    ]
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /not available locally \(not installed\)/);
  assert.match(result.errors.join('\n'), /not authenticated/);
});

test('preflight handles missing implementations, crashes, cache, forced probes, and probeAll failures', async () => {
  const stateDir = tempDir('agent-team-preflight-');
  let probes = 0;
  const claude = backend('claude', {
    listModels: async () => { throw new Error('catalog down'); },
    probe: async () => { probes += 1; return { ok: true, latencyMs: 2 }; }
  });
  const binding = { agent: 'custom', backend: 'claude', model: 'custom', source: 'test' };
  const input = { config: config(stateDir), backends: { claude, codex: backend('codex'), opencode: backend('opencode') }, bindings: [binding, { ...binding, agent: 'duplicate' }] };
  const first = await checkAgentAvailability(input);
  assert.equal(first.ok, true);
  assert.equal(probes, 1);
  assert.match(first.warnings.join('\n'), /model enumeration failed/);
  const cached = await checkAgentAvailability(input);
  assert.equal(cached.ok, true);
  assert.equal(probes, 1);
  await checkAgentAvailability({ ...input, forceProbe: true });
  assert.equal(probes, 2);

  const missing = await checkAgentAvailability({ ...input, bindings: [{ agent: 'none', backend: 'codex', model: 'listed', source: 'test' }], backends: { claude, codex: undefined, opencode: backend('opencode') } });
  assert.match(missing.errors[0], /no implementation registered/);
  const crashed = await checkAgentAvailability({ ...input, bindings: [{ agent: 'crash', backend: 'codex', source: 'test' }], backends: { claude, codex: backend('codex', { discover: async () => { throw new Error('boom'); } }), opencode: backend('opencode') } });
  assert.match(crashed.errors[0], /discovery failed: boom/);

  const all = await probeAll({
    ...input,
    bindings: [binding, { ...binding, agent: 'duplicate' }, { agent: 'crash', backend: 'codex', source: 'test' }, { agent: 'absent', backend: 'opencode', source: 'test' }],
    backends: {
      claude,
      codex: backend('codex', { probe: async () => { throw new Error('probe boom'); } }),
      opencode: undefined
    }
  });
  assert.deepEqual(all.map(({ agent, ok, error }) => ({ agent, ok, error })), [
    { agent: 'custom', ok: true, error: undefined },
    { agent: 'crash', ok: false, error: 'probe boom' }
  ]);
});

test('bindingsForRun falls back from invalid snapshots and deduplicates task agents', () => {
  const value = {
    ...DEFAULT_CONFIG,
    agents: {
      main: { backend: 'claude' },
      specialist: { backend: 'codex', model: 'm' }
    },
    defaultAgent: 'main'
  };
  const bindings = bindingsForRun(value, '{bad json', JSON.stringify({ tasks: [{ agent: 'specialist' }, { agent: 'specialist' }] }));
  assert.equal(bindings.filter((binding) => binding.agent === 'specialist').length, 1);
  assert.equal(bindings.filter((binding) => binding.agent === 'main').length, 4);
});
