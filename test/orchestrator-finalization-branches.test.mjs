import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/core/defaults.ts';
import { StateDatabase } from '../src/core/db.ts';
import { currentHead, git } from '../src/core/git.ts';
import { snapshotAgents } from '../src/agent/registry.ts';
import { runOrchestrator } from '../src/core/orchestrator.ts';

async function repository(scripts = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-finalization-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'feature.txt'), 'base\n', 'utf8');
  writeFileSync(join(repoRoot, 'goal.md'), '# Goal\n', 'utf8');
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, scripts }), 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'test']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  return repoRoot;
}

function configFor(repoRoot, overrides = {}) {
  const { verification, workspace, retry, status, ...rest } = overrides;
  const name = basename(repoRoot);
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace, repoRoot, stateDir: join(tmpdir(), `${name}-state`), worktreesDir: join(tmpdir(), `${name}-worktrees`), ...workspace },
    retry: { ...DEFAULT_CONFIG.retry, ...retry },
    status: { ...DEFAULT_CONFIG.status, ...status },
    concurrency: 1,
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [], ...verification },
    ...rest
  };
}

function task() {
  return {
    id: 'T001', title: 'Change feature', description: 'Update the feature file.', dependsOn: [],
    allowedPaths: ['src/**'], blockedPaths: [], acceptance: ['feature is updated'], verificationCommands: []
  };
}

class ScriptBackend {
  id = 'claude';
  capabilities = { maxTurns: true, resumeSession: true };
  specs = [];

  constructor(handler) {
    this.handler = handler;
  }

  async discover() { return { backend: this.id, installed: true, authed: true }; }
  async listModels() { return []; }
  async probe() { return { ok: true, latencyMs: 1 }; }
  async openSession(spec) {
    this.specs.push(spec);
    return {
      async interrupt() {},
      async close() {},
      completion: async () => ({ ok: true, output: await this.handler(spec), timedOut: false, stalled: false })
    };
  }
}

function backendPool(backend) {
  return { claude: backend, codex: backend, opencode: backend };
}

function eventTypes(db, runId) {
  return db.db.prepare('SELECT event_type FROM events WHERE run_id = ? ORDER BY id').all(runId).map((row) => row.event_type);
}

async function createApprovedRun(db, config, id = 'run') {
  const baseSha = await currentHead(config.workspace.repoRoot);
  const manifest = { version: 1, title: 'Run', summary: 'test run', tasks: [task()] };
  db.createRun({ id, repoRoot: config.workspace.repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'claude' });
  db.insertTask(id, task());
  db.updateRun(id, { status: 'planned', manifestJson: JSON.stringify(manifest), rolesJson: JSON.stringify(snapshotAgents(config)) });
  mkdirSync(join(config.workspace.stateDir, 'runs', id), { recursive: true });

  const seed = mkdtempSync(join(tmpdir(), 'agent-team-finalization-seed-'));
  const worktree = join(seed, 'task');
  await git(config.workspace.repoRoot, ['worktree', 'add', '-q', '-b', `seed-${basename(seed)}`, worktree, baseSha]);
  writeFileSync(join(worktree, 'src', 'feature.txt'), 'implemented\n', 'utf8');
  await git(worktree, ['add', 'src/feature.txt']);
  await git(worktree, ['commit', '-q', '-m', 'task implementation']);
  const commitSha = await currentHead(worktree);
  db.updateTask(id, 'T001', { status: 'approved', phase: 'done', commitSha });
  return { runDir: join(config.workspace.stateDir, 'runs', id) };
}

test('orchestrator completes a conflict-free integration without starting an Integrator', async () => {
  const repoRoot = await repository({ verify: 'node -e ""' });
  const config = configFor(repoRoot, { verification: { globalCommands: ['npm run verify'] } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend(() => { throw new Error('Integrator must not start without a conflict'); });
  try {
    const { runDir } = await createApprovedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const run = db.getRun('run');
    assert.equal(run.status, 'done');
    assert.equal(run.integrationCommit, await currentHead(run.integrationWorktree));
    assert.equal(backend.specs.length, 0);
    assert.equal(readFileSync(join(run.integrationWorktree, 'src', 'feature.txt'), 'utf8'), 'implemented\n');
    assert.match(readFileSync(join(runDir, 'logs', 'integration-verification.log'), 'utf8'), /\$ npm run verify/);
    assert.deepEqual(eventTypes(db, 'run').slice(-2), ['INTEGRATION_COMPLETED', 'RUN_COMPLETED']);
  } finally {
    db.close();
  }
});

test('orchestrator records outer-signal aborts without setting the process exit code', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const controller = new AbortController();
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  let interrupted = 0;
  const backend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'worker');
    controller.abort();
    return { status: 'completed', summary: 'too late', testsRun: [], knownRisks: [] };
  });
  const originalOpenSession = backend.openSession.bind(backend);
  backend.openSession = async (spec) => {
    const session = await originalOpenSession(spec);
    return { ...session, interrupt: async () => { interrupted += 1; } };
  };
  try {
    await createApprovedRun(db, config);
    db.updateTask('run', 'T001', { status: 'pending', phase: 'pending', commitSha: null });
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend), signal: controller.signal });

    assert.equal(interrupted, 1);
    assert.equal(process.exitCode, undefined);
    assert.equal(db.getRun('run').status, 'running');
    assert.equal(db.getRun('run').error, 'Interrupted by an outer signal; run again to resume.');
    assert.equal(eventTypes(db, 'run').includes('RUN_INTERRUPTED'), true);
  } finally {
    process.exitCode = exitCode;
    db.close();
  }
});

test('orchestrator handles an already aborted daemon signal without opening a session', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const controller = new AbortController();
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  controller.abort();
  const backend = new ScriptBackend(() => { throw new Error('agent must not start'); });
  try {
    await createApprovedRun(db, config);
    db.updateTask('run', 'T001', { status: 'pending', phase: 'pending', commitSha: null });
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend), signal: controller.signal });

    assert.equal(backend.specs.length, 0);
    assert.equal(process.exitCode, undefined);
    assert.equal(db.getRun('run').error, 'Interrupted by an outer signal; run again to resume.');
    assert.equal(existsSync(join(config.workspace.stateDir, 'runs', 'run', 'summary.txt')), false);
  } finally {
    process.exitCode = exitCode;
    db.close();
  }
});
