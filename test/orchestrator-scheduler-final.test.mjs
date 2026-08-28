import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { StateDatabase } from '../src/core/db.ts';
import { currentHead, git } from '../src/core/git.ts';
import { snapshotAgents } from '../src/agent/registry.ts';
import { runOrchestrator } from '../src/core/orchestrator.ts';

async function repository() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-scheduler-final-'));
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
    retry: { ...DEFAULT_CONFIG.retry, maxWorkerAttempts: 2, maxReviewCycles: 2, ...retry },
    status: { ...DEFAULT_CONFIG.status, ...status },
    integration: { ...DEFAULT_CONFIG.integration, runAgentAfterCherryPick: false },
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [] },
    ...rest
  };
}

function task(id = 'T001', overrides = {}) {
  return {
    id,
    title: `Change ${id}`,
    description: 'Update the feature file.',
    dependsOn: [],
    allowedPaths: ['src/**'],
    blockedPaths: [],
    acceptance: ['feature is updated'],
    verificationCommands: [],
    ...overrides
  };
}

function workerResult() {
  return {
    status: 'completed',
    summary: 'implemented',
    testsRun: [],
    knownRisks: [],
    architectureImpact: 'none',
    progressImpact: 'none'
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

async function createPlannedRun(db, config, tasks = [task()], id = 'run') {
  const baseSha = await currentHead(config.workspace.repoRoot);
  const manifest = { version: 1, title: 'Run', summary: 'scheduler test', tasks };
  db.createRun({ id, repoRoot: config.workspace.repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'claude' });
  for (const spec of tasks) db.insertTask(id, spec);
  db.updateRun(id, {
    status: 'planned', manifestJson: JSON.stringify(manifest), rolesJson: JSON.stringify(snapshotAgents(config))
  });
}

function eventTypes(db, runId = 'run') {
  return db.db.prepare('SELECT event_type FROM events WHERE run_id = ? ORDER BY id').all(runId).map((row) => row.event_type);
}

test('orchestrator rejects invalid run states and no-ops completed runs', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend(() => {
    throw new Error('agent must not start');
  });
  try {
    const baseSha = await currentHead(repoRoot);
    db.createRun({ id: 'planning', repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'claude' });
    await assert.rejects(
      runOrchestrator({ config, db, runId: 'planning', backends: backendPool(backend) }),
      /cannot start from status planning/
    );

    await createPlannedRun(db, config, [task()], 'complete');
    db.updateRun('complete', { status: 'done', error: 'preserved terminal state' });
    await runOrchestrator({ config, db, runId: 'complete', backends: backendPool(backend) });

    assert.equal(db.getRun('complete').status, 'done');
    assert.equal(db.getRun('complete').error, 'preserved terminal state');
    assert.equal(eventTypes(db, 'complete').includes('RUN_STARTED'), false);
    assert.equal(backend.specs.length, 0);
  } finally {
    db.close();
  }
});

test('orchestrator stops when a dependency has already failed or is blocked', async () => {
  for (const status of ['failed', 'blocked']) {
    const repoRoot = await repository();
    const config = configFor(repoRoot);
    const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
    const backend = new ScriptBackend(() => {
      throw new Error('dependent task must not start');
    });
    try {
      await createPlannedRun(db, config, [task('T001'), task('T002', { dependsOn: ['T001'] })]);
      db.updateTask('run', 'T001', { status, phase: 'worker', lastError: `${status} upstream`, finishedAt: new Date().toISOString() });

      await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

      assert.equal(db.getRun('run').status, 'needs_attention');
      assert.match(db.getRun('run').error, new RegExp(`T001: ${status} upstream`));
      assert.equal(db.getTask('run', 'T002').status, 'pending');
      assert.equal(backend.specs.length, 0);
    } finally {
      db.close();
    }
  }
});

test('orchestrator records an invalid worker result as a task exception', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'worker');
    return { status: 'unknown' };
  });
  try {
    await createPlannedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const record = db.getTask('run', 'T001');
    assert.equal(db.getRun('run').status, 'needs_attention');
    assert.equal(record.status, 'failed');
    assert.equal(record.phase, 'exception');
    assert.match(record.lastError, /Invalid worker status/);
    assert.equal(record.attempts, 1);
    assert.ok(eventTypes(db).includes('TASK_EXCEPTION'));
  } finally {
    db.close();
  }
});

test('orchestrator fails a task when reviewer feedback reaches the cycle limit', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot, { retry: { maxReviewCycles: 1 } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    if (spec.role === 'worker') {
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'changed\n', 'utf8');
      return workerResult();
    }
    assert.equal(spec.role, 'reviewer');
    return { decision: 'changes_requested', summary: 'needs another pass', findings: [], requiredChanges: ['fix it'] };
  });
  try {
    await createPlannedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const record = db.getTask('run', 'T001');
    assert.equal(db.getRun('run').status, 'needs_attention');
    assert.equal(record.status, 'failed');
    assert.equal(record.phase, 'review');
    assert.equal(record.reviewCycles, 1);
    assert.match(record.lastError, /needs another pass/);
    assert.ok(eventTypes(db).includes('REVIEW_LIMIT_REACHED'));
  } finally {
    db.close();
  }
});

test('orchestrator reports pending work when concurrency leaves no runnable slot', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot, { concurrency: 0 });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend(() => {
    throw new Error('no worker slot is available');
  });
  try {
    await createPlannedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    assert.equal(db.getRun('run').status, 'needs_attention');
    assert.match(db.getRun('run').error, /No runnable tasks remain/);
    assert.equal(db.getTask('run', 'T001').status, 'pending');
    assert.equal(backend.specs.length, 0);
  } finally {
    db.close();
  }
});

test('orchestrator records a blocked worker without starting a reviewer', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'worker');
    return { ...workerResult(), status: 'blocked', summary: 'cannot continue', blockedReason: 'missing credential' };
  });
  try {
    await createPlannedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });
    const record = db.getTask('run', 'T001');
    assert.equal(record.status, 'blocked');
    assert.equal(record.lastError, 'missing credential');
    assert.equal(backend.specs.length, 1);
    assert.ok(eventTypes(db).includes('WORKER_BLOCKED'));
  } finally {
    db.close();
  }
});

test('orchestrator rejects reviewer changes to the task worktree', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot, { retry: { maxWorkerAttempts: 1 } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    if (spec.role === 'worker') {
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'worker change\n');
      return workerResult();
    }
    writeFileSync(join(spec.cwd, 'src', 'reviewer.txt'), 'forbidden\n');
    return { decision: 'approved', summary: 'ignored', findings: [], requiredChanges: [] };
  });
  try {
    await createPlannedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });
    const record = db.getTask('run', 'T001');
    assert.equal(record.status, 'failed');
    assert.match(record.lastError, /Reviewer modified Git state or files/);
    assert.ok(eventTypes(db).includes('WORKER_RETRY_LIMIT_REACHED'));
  } finally {
    db.close();
  }
});
