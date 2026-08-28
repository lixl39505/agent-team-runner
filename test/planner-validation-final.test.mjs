import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, applyOverrides, loadConfig } from '../src/core/config.ts';
import { backendCommand, migrateV1Fields, parseInlineAgentSpec, validateAgents } from '../src/core/agent-config.ts';
import { StateDatabase } from '../src/core/db.ts';
import { planRun } from '../src/core/planner.ts';
import { runCommand, splitCommand } from '../src/core/shell.ts';
import { validateIntegrationResult, validateLeadResult, validateReviewResult, validateWorkerResult, topologicalTasks } from '../src/core/validation.ts';
import { runGlobalVerification, verifyTaskWorktree } from '../src/core/verifier.ts';

function repository(prefix = 'agent-team-final-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'goal.md'), '# Goal\n');
  writeFileSync(join(root, 'src', 'file.txt'), 'base\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Tests'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return root;
}

function task(id = 'T001', overrides = {}) {
  return {
    id,
    title: id,
    description: 'Implement the change.',
    dependsOn: [],
    allowedPaths: [`src/${id}/**`],
    blockedPaths: [],
    acceptance: ['complete'],
    verificationCommands: [],
    ...overrides
  };
}

function manifest() {
  return { version: 1, title: 'Plan', summary: 'Summary', tasks: [task()] };
}

function plannerConfig(repoRoot) {
  return {
    ...DEFAULT_CONFIG,
    repoRoot,
    stateDir: join(repoRoot, '.state'),
    worktreesDir: join(repoRoot, '.worktrees'),
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [] }
  };
}

class FakeLeadBackend {
  id = 'claude';
  capabilities = { maxTurns: true, resumeSession: true };

  constructor(completion) {
    this.completion = completion;
  }

  async discover() { return { backend: this.id, installed: true, authed: true }; }
  async listModels() { return []; }
  async probe() { return { ok: true, latencyMs: 1 }; }
  async openSession() {
    return {
      async interrupt() {},
      async close() {},
      completion: this.completion
    };
  }
}

test('planner generates a fallback slug and records signal interruption without a real backend', async () => {
  const repo = repository();
  const config = plannerConfig(repo);
  const db = new StateDatabase(join(config.stateDir, 'state.sqlite'));
  const success = new FakeLeadBackend(async () => ({ ok: true, output: manifest(), timedOut: false, stalled: false }));
  const pool = { claude: success, codex: success, opencode: success };
  try {
    writeFileSync(join(repo, '!!!.md'), '# Fallback slug\n');
    const generated = await planRun({ config, db, goalFile: '!!!.md', backends: pool });
    assert.match(generated, /^run-\d{14}$/);
    assert.equal(db.getRun(generated).status, 'planned');

    const interrupted = new FakeLeadBackend(async () => {
      process.emit('SIGHUP');
      return { ok: true, output: manifest(), timedOut: false, stalled: false };
    });
    await assert.rejects(
      planRun({ config, db, goalFile: 'goal.md', runId: 'interrupted', backends: { claude: interrupted, codex: interrupted, opencode: interrupted } }),
      /Planning interrupted by user/
    );
    assert.equal(db.getRun('interrupted').status, 'failed');
  } finally {
    process.exitCode = undefined;
    db.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('validation preserves optional values, defaults omissions, and rejects path and manifest edges', () => {
  const full = validateLeadResult({
    version: '1', title: 'Plan', summary: 'Summary', tasks: [task('T001', {
      role: 'worker', agent: 'named', allowNoChanges: false, blockedPaths: ['.git/**']
    })]
  }, ['named']);
  assert.equal(full.tasks[0].role, 'worker');
  assert.equal(full.tasks[0].agent, 'named');
  assert.equal(full.tasks[0].allowNoChanges, false);
  assert.deepEqual(validateLeadResult({ version: 1, title: 'Plan', summary: 'Summary', tasks: [task()] }).tasks[0].dependsOn, []);
  assert.equal(validateLeadResult({ version: 1, title: '', summary: 'Summary', tasks: [task()] }).title, '');

  for (const value of [
    { version: 0, title: 'Plan', summary: 'Summary', tasks: [task()] },
    { version: 1, title: 'Plan', summary: 1, tasks: [task()] },
    { version: 1, title: 'Plan', summary: 'Summary', tasks: [task('X')] },
    { version: 1, title: 'Plan', summary: 'Summary', tasks: [task('T001', { allowedPaths: ['\\absolute'] })] },
    { version: 1, title: 'Plan', summary: 'Summary', tasks: [task('T001', { allowedPaths: ['C:\\outside'] })] }
  ]) assert.throws(() => validateLeadResult(value));

  assert.throws(() => validateLeadResult({
    version: 1, title: 'Plan', summary: 'Summary', tasks: [
      task('T001', { allowedPaths: ['src/**'] }),
      task('T002', { allowedPaths: ['src/a/**'] })
    ]
  }), /overlap writable paths/);
  assert.doesNotThrow(() => validateLeadResult({
    version: 1, title: 'Plan', summary: 'Summary', tasks: [
      task('T001', { allowedPaths: ['src/a/**'] }),
      task('T002', { allowedPaths: ['lib/b/**'] })
    ]
  }));
  assert.deepEqual(topologicalTasks([
    task('T003', { dependsOn: ['T001', 'T002'] }), task('T001'), task('T002')
  ]).map(({ id }) => id), ['T001', 'T002', 'T003']);

  assert.deepEqual(validateWorkerResult({ status: 'completed' }), {
    status: 'completed', summary: '', testsRun: [], knownRisks: [], architectureImpact: '', progressImpact: ''
  });
  assert.equal(validateWorkerResult({ status: 'blocked', blockedReason: 'wait' }).blockedReason, 'wait');
  assert.equal(validateReviewResult({ decision: 'changes_requested', findings: [{ severity: 'high', file: 'a.ts', message: 'fix' }] }).findings[0].line, undefined);
  assert.equal(validateIntegrationResult({ status: 'failed', blockedReason: 'conflict' }).blockedReason, 'conflict');
});

test('config and v1 agent migration handle absent files, malformed references, and slug collisions', () => {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-config-final-'));
  try {
    assert.equal(loadConfig(repo).repoRoot, repo);
    mkdirSync(join(repo, '.agent-team'));
    writeFileSync(join(repo, '.agent-team', 'config.yaml'), 'defaultAgent: missing\nagents: {}\n');
    assert.equal(loadConfig(repo).defaultAgent, 'missing');
    const overridden = applyOverrides({ ...DEFAULT_CONFIG, roles: null }, [{ key: 'roles.lead', value: 'named' }]);
    assert.equal(overridden.roles.lead, 'named');

    const migrated = migrateV1Fields({
      adapters: {
        claude: { extraArgs: ['--quiet'] }, codex: { command: 'codex' }, opencode: {}
      },
      models: { slash: 'a/b', dash: 'a-b' },
      roles: { lead: 'codex.slash', worker: 'codex.dash', ignored: '', malformed: 'claude' },
      defaultAdapter: 'codex'
    });
    assert.deepEqual(migrated.agents['codex-a-b'], { backend: 'codex', model: 'a/b' });
    assert.deepEqual(migrated.agents['codex-a-b-2'], { backend: 'codex', model: 'a-b' });
    assert.equal(migrated.roles.worker, 'codex-a-b-2');
    assert.match(migrated.v2Yaml, /defaultAgent: default-codex/);

    assert.equal(backendCommand({ ...DEFAULT_CONFIG, backends: { ...DEFAULT_CONFIG.backends, codex: { command: '   ' } } }, 'codex'), 'codex');
    assert.equal(parseInlineAgentSpec('claude.model.with.dots').model, 'model.with.dots');
    const invalid = validateAgents({ ...DEFAULT_CONFIG, agents: { good: { backend: 'claude' } }, defaultAgent: 'good', roles: { blank: '', malformed: 'codex' } });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors[0], /unknown agent/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('shell execution captures output, rejects missing executables, and parses Windows escaped quotes', async () => {
  assert.deepEqual(splitCommand('tool "C:\\path\\\\\\\"quoted\\\".txt"', 'win32'), ['tool', 'C:\\path\\"quoted".txt']);
  const output = [];
  assert.equal(await runCommand('node -e "process.stdout.write(\'ok\')"', tmpdir(), (line) => output.push(line)), 0);
  assert.equal(output.join(''), 'ok');
  await assert.rejects(runCommand('definitely-not-an-agent-team-command', tmpdir()), /ENOENT/);
});

test('verifier accepts stable checks and rejects unsafe global commands before execution', async () => {
  const repo = repository('agent-team-verifier-final-');
  const logs = mkdtempSync(join(tmpdir(), 'agent-team-verifier-final-logs-'));
  const logPath = join(logs, 'verification.log');
  const startSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'src', 'file.txt'), 'worker change\n');
  const config = {
    ...DEFAULT_CONFIG,
    verification: { allowedCommandPrefixes: ['node -e'], globalCommands: ['node -e "process.exit(0)"'] }
  };
  try {
    const result = await verifyTaskWorktree({
      worktree: repo,
      task: task('T001', { allowedPaths: ['src/**'], verificationCommands: ['node -e "process.stdout.write(\'checked\')"'] }),
      startSha,
      config,
      logPath
    });
    assert.deepEqual(result, { ok: true, changedFiles: ['src/file.txt'] });
    assert.match(readFileSync(logPath, 'utf8'), /checked/);
    await runGlobalVerification({ worktree: repo, config, logPath });
    await assert.rejects(
      runGlobalVerification({
        worktree: repo,
        config: { ...config, verification: { ...config.verification, globalCommands: ['rm -rf /'] } },
        logPath
      }),
      /not allowlisted|Unsafe shell syntax/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  }
});
