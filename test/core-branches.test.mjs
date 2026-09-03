import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/core/defaults.ts';
import { agentList, backendCommand, isBackendId, isValidAgentName, parseInlineAgentSpec, validateAgents } from '../src/core/agent-config.ts';
import { checkPaths, globMatch, patternMatches } from '../src/core/path-policy.ts';
import { validateIntegrationResult, validateReviewResult, validateTaskGraph, validateWorkerResult } from '../src/core/validation.ts';
import { assertAllowedCommand, splitCommand } from '../src/core/shell.ts';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function repo() {
  const root = tempDir('agent-team-core-');
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
  return { ...DEFAULT_CONFIG, workspace: { ...DEFAULT_CONFIG.workspace, stateDir } };
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

test('agent config validates malformed registry entries', () => {
  const invalid = {
    ...DEFAULT_CONFIG,
    defaultAgent: 'missing',
    agents: { 'bad.name': { backend: 'unknown' } },
    roles: { reviewer: 'codex.model', worker: 'nope' }
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
  assert.throws(() => validateTaskGraph([task('T001', { dependsOn: ['T002'] }), task('T002', { dependsOn: ['T001'] })]), /cycle/);
  assert.throws(() => validateWorkerResult({ status: 'unknown' }), /Invalid worker status/);
  assert.throws(() => validateWorkerResult({ status: 'completed', testsRun: 'no' }), /testsRun must be a string array/);
  assert.throws(() => validateReviewResult({ decision: 'approved', findings: [{ severity: 'urgent' }] }), /Invalid finding severity/);
  assert.throws(() => validateIntegrationResult({ status: 'blocked', knownRisks: 'no' }), /knownRisks must be a string array/);
  assert.deepEqual(validateReviewResult({ decision: 'approved', findings: [], requiredChanges: [] }), {
    decision: 'approved', summary: '', findings: [], requiredChanges: []
  });
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




