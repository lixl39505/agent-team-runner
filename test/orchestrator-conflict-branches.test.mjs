import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/core/defaults.ts';
import { StateDatabase } from '../src/core/db.ts';
import { currentHead, git } from '../src/core/git.ts';
import { snapshotAgents } from '../src/agent/registry.ts';
import { runOrchestrator } from '../src/core/orchestrator.ts';

async function repository() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-conflicts-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'feature.txt'), 'base\n', 'utf8');
  writeFileSync(join(repoRoot, 'goal.md'), '# Goal\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'test']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  return repoRoot;
}

function configFor(repoRoot, overrides = {}) {
  const { workspace, retry, status, ...rest } = overrides;
  const name = basename(repoRoot);
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace, repoRoot, stateDir: join(tmpdir(), `${name}-state`), worktreesDir: join(tmpdir(), `${name}-worktrees`), ...workspace },
    concurrency: 1,
    retry: { ...DEFAULT_CONFIG.retry, maxWorkerAttempts: 2, ...retry },
    status: { ...DEFAULT_CONFIG.status, ...status },
    integration: { ...DEFAULT_CONFIG.integration },
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [] },
    ...rest
  };
}

function task(id, overrides = {}) {
  return {
    id,
    title: `Change ${id}`,
    description: 'Change the feature file.',
    dependsOn: [],
    allowedPaths: ['src/**'],
    blockedPaths: [],
    acceptance: ['feature is updated'],
    verificationCommands: [],
    ...overrides
  };
}

function workerResult(status, summary) {
  return {
    status,
    summary,
    testsRun: [],
    knownRisks: []
  };
}

function integrationResult(status = 'completed') {
  return { status, summary: 'handled conflict', testsRun: [], knownRisks: [] };
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
      completion: async () => {
        const response = await this.handler(spec);
        return response && Object.hasOwn(response, 'ok')
          ? response
          : { ok: true, output: response, timedOut: false, stalled: false };
      }
    };
  }
}

function backendPool(backend) {
  return { claude: backend, codex: backend, opencode: backend };
}

async function createPlannedRun(db, config, tasks, id = 'run') {
  const baseSha = await currentHead(config.workspace.repoRoot);
  const manifest = { version: 1, title: 'Run', summary: 'test run', tasks };
  db.createRun({ id, repoRoot: config.workspace.repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'claude' });
  for (const spec of tasks) db.insertTask(id, spec);
  db.updateRun(id, {
    status: 'planned', manifestJson: JSON.stringify(manifest), rolesJson: JSON.stringify(snapshotAgents(config))
  });
  return baseSha;
}

async function createConflictingCommit(repoRoot, baseSha, id, content) {
  const seedRoot = mkdtempSync(join(tmpdir(), 'agent-team-conflict-seed-'));
  const worktree = join(seedRoot, id);
  await git(repoRoot, ['worktree', 'add', '-q', '-b', `seed-${id}-${basename(seedRoot)}`, worktree, baseSha]);
  writeFileSync(join(worktree, 'src', 'feature.txt'), content, 'utf8');
  await git(worktree, ['add', 'src/feature.txt']);
  await git(worktree, ['commit', '-q', '-m', `change ${id}`]);
  return currentHead(worktree);
}

async function createApprovedConflictRun(handler) {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const tasks = [task('T001'), task('T002')];
  const baseSha = await createPlannedRun(db, config, tasks);
  const firstCommit = await createConflictingCommit(repoRoot, baseSha, 'T001', 'first\n');
  const secondCommit = await createConflictingCommit(repoRoot, baseSha, 'T002', 'second\n');
  db.updateTask('run', 'T001', { status: 'approved', phase: 'done', commitSha: firstCommit });
  db.updateTask('run', 'T002', { status: 'approved', phase: 'done', commitSha: secondCommit });
  return { config, db, backend: new ScriptBackend(handler) };
}

test('orchestrator marks an active task interrupted and discards its attempt', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const exitCode = process.exitCode;
  const backend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'worker');
    process.emit('SIGINT');
    return { ok: false, output: null, error: 'transport stopped', timedOut: false, stalled: false };
  });
  try {
    await createPlannedRun(db, config, [task('T001')]);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const record = db.getTask('run', 'T001');
    assert.equal(db.getRun('run').status, 'running');
    assert.match(db.getRun('run').error, /Interrupted by user/);
    assert.equal(record.status, 'changes_requested');
    assert.equal(record.phase, 'interrupted');
    assert.equal(record.attempts, 0);
    assert.match(record.lastError, /next run will discard this attempt/);
  } finally {
    process.exitCode = exitCode;
    db.close();
  }
});

test('orchestrator reports a persisted DAG with no executable task', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend(() => {
    throw new Error('no agent should be started for an unrunnable graph');
  });
  try {
    await createPlannedRun(db, config, [task('T001', { dependsOn: ['MISSING'] })]);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    assert.equal(db.getRun('run').status, 'needs_attention');
    assert.match(db.getRun('run').error, /No runnable tasks remain/);
    assert.equal(db.getTask('run', 'T001').status, 'pending');
    assert.equal(backend.specs.length, 0);
  } finally {
    db.close();
  }
});

test('orchestrator lets the integrator resolve a real cherry-pick conflict within the conflict files', async () => {
  const setup = await createApprovedConflictRun((spec) => {
    assert.equal(spec.role, 'integrator');
    writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'resolved\n', 'utf8');
    return integrationResult();
  });
  try {
    const events = [];
    await runOrchestrator({
      config: setup.config,
      db: setup.db,
      runId: 'run',
      backends: backendPool(setup.backend),
      onAgentEvent: (execution, event) => events.push([execution.role, event.type])
    });

    const run = setup.db.getRun('run');
    assert.equal(run.status, 'done');
    assert.equal(setup.backend.specs.length, 1);
    assert.deepEqual(events, [['integrator', 'activity']]);
    assert.equal(readFileSync(join(run.integrationWorktree, 'src', 'feature.txt'), 'utf8'), 'resolved\n');
    assert.equal((await git(run.integrationWorktree, ['status', '--porcelain'])).stdout, '');
  } finally {
    setup.db.close();
  }
});

test('orchestrator aborts a cherry-pick when the conflict resolver changes an unrelated path', async () => {
  const setup = await createApprovedConflictRun((spec) => {
    assert.equal(spec.role, 'integrator');
    writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'resolved\n', 'utf8');
    writeFileSync(join(spec.cwd, 'outside.txt'), 'outside\n', 'utf8');
    return integrationResult();
  });
  try {
    await assert.rejects(
      runOrchestrator({ config: setup.config, db: setup.db, runId: 'run', backends: backendPool(setup.backend) }),
      /Conflict resolver modified unrelated files: outside\.txt/
    );

    const run = setup.db.getRun('run');
    assert.equal(run.status, 'failed');
    assert.equal((await git(run.integrationWorktree, ['diff', '--name-only', '--diff-filter=U'])).stdout, '');
    assert.match((await git(run.integrationWorktree, ['status', '--porcelain'])).stdout, /\?\? outside\.txt/);
  } finally {
    setup.db.close();
  }
});

test('orchestrator aborts a cherry-pick when the conflict resolver backend fails', async () => {
  const setup = await createApprovedConflictRun((spec) => {
    assert.equal(spec.role, 'integrator');
    return { ok: false, output: null, error: 'integrator transport failed', timedOut: false, stalled: false };
  });
  try {
    await assert.rejects(
      runOrchestrator({ config: setup.config, db: setup.db, runId: 'run', backends: backendPool(setup.backend) }),
      /Integrator failed to resolve conflict for T002/
    );

    const run = setup.db.getRun('run');
    assert.equal(run.status, 'failed');
    assert.equal((await git(run.integrationWorktree, ['diff', '--name-only', '--diff-filter=U'])).stdout, '');
    assert.equal((await git(run.integrationWorktree, ['status', '--porcelain'])).stdout, '');
  } finally {
    setup.db.close();
  }
});
