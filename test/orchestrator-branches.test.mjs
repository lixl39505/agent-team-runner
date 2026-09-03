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
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-branches-'));
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
    integration: { ...DEFAULT_CONFIG.integration },
    verification: { ...DEFAULT_CONFIG.verification },
    ...rest
  };
}

function task() {
  return {
    id: 'T001', title: 'Change feature', description: 'Update the feature file.',
    dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [],
    acceptance: ['feature is updated'], verificationCommands: []
  };
}

function workerResult(status, summary) {
  return {
    status, summary, testsRun: [], knownRisks: []
  };
}

function approvedReview() {
  return { decision: 'approved', summary: 'approved', findings: [], requiredChanges: [] };
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

async function createPlannedRun(db, config, id = 'run') {
  const baseSha = await currentHead(config.workspace.repoRoot);
  const manifest = { version: 1, title: 'Run', summary: 'test run', tasks: [task()] };
  db.createRun({ id, repoRoot: config.workspace.repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'claude' });
  db.insertTask(id, task());
  db.updateRun(id, {
    status: 'planned', manifestJson: JSON.stringify(manifest), rolesJson: JSON.stringify(snapshotAgents(config))
  });
  return baseSha;
}

function eventTypes(db, runId) {
  return db.db.prepare('SELECT event_type FROM events WHERE run_id = ? ORDER BY id').all(runId).map((row) => row.event_type);
}

test('orchestrator retries missing worker output and a failed worker result until the retry limit', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  let workers = 0;
  const backend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'worker');
    workers += 1;
    return workers === 1
      ? { ok: true, output: null, timedOut: false, stalled: false }
      : workerResult('failed', 'worker reported a deterministic failure');
  });
  try {
    await createPlannedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const record = db.getTask('run', 'T001');
    assert.equal(workers, 2);
    assert.equal(record.status, 'failed');
    assert.equal(record.phase, 'retry-limit');
    assert.equal(record.attempts, 2);
    assert.match(record.lastError, /worker reported a deterministic failure/);
    assert.equal(db.getRun('run').status, 'needs_attention');
    assert.deepEqual(eventTypes(db, 'run').filter((type) => type === 'WORKER_RETRY_SCHEDULED').length, 1);
    assert.deepEqual(eventTypes(db, 'run').filter((type) => type === 'WORKER_RETRY_LIMIT_REACHED').length, 1);
  } finally {
    db.close();
  }
});

test('orchestrator retries a reviewer transport failure and then integrates the approved retry', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  let workers = 0;
  let reviews = 0;
  const backend = new ScriptBackend((spec) => {
    if (spec.role === 'worker') {
      workers += 1;
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), workers === 1 ? 'first\n' : 'fixed\n', 'utf8');
      return workerResult('completed', `worker pass ${workers}`);
    }
    assert.equal(spec.role, 'reviewer');
    reviews += 1;
    return reviews === 1
      ? { ok: false, output: null, error: 'review transport closed', timedOut: false, stalled: false }
      : approvedReview();
  });
  try {
    await createPlannedRun(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const record = db.getTask('run', 'T001');
    assert.equal(db.getRun('run').status, 'done');
    assert.equal(record.status, 'approved');
    assert.equal(record.attempts, 2);
    assert.equal(record.reviewCycles, 1);
    assert.equal(workers, 2);
    assert.equal(reviews, 2);
    assert.equal(readFileSync(join(db.getRun('run').integrationWorktree, 'src', 'feature.txt'), 'utf8'), 'fixed\n');
    assert.equal(eventTypes(db, 'run').filter((type) => type === 'WORKER_RETRY_SCHEDULED').length, 1);
  } finally {
    db.close();
  }
});

test('orchestrator resumes a failed run by resetting its interrupted worktree before retrying', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    if (spec.role === 'worker') {
      assert.equal(readFileSync(join(spec.cwd, 'src', 'feature.txt'), 'utf8'), 'base\n');
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'recovered\n', 'utf8');
      return workerResult('completed', 'recovered cleanly');
    }
    assert.equal(spec.role, 'reviewer');
    return approvedReview();
  });
  try {
    const baseSha = await createPlannedRun(db, config);
    const worktree = join(config.workspace.worktreesDir, basename(repoRoot), 'run', 'T001');
    const branch = `${config.workspace.branchPrefix}/run/T001`;
    mkdirSync(join(config.workspace.worktreesDir, basename(repoRoot), 'run'), { recursive: true });
    await git(repoRoot, ['worktree', 'add', '-q', '-b', branch, worktree, baseSha]);
    writeFileSync(join(worktree, 'src', 'feature.txt'), 'abandoned\n', 'utf8');
    db.updateTask('run', 'T001', {
      status: 'running', phase: 'worker-active', branch, worktree, startSha: baseSha, attempts: 1
    });
    db.updateRun('run', { status: 'failed', error: 'interrupted' });

    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const record = db.getTask('run', 'T001');
    assert.equal(db.getRun('run').status, 'done');
    assert.equal(record.status, 'approved');
    assert.equal(record.attempts, 2);
    assert.equal(readFileSync(join(db.getRun('run').integrationWorktree, 'src', 'feature.txt'), 'utf8'), 'recovered\n');
    assert.ok(eventTypes(db, 'run').includes('TASK_RECOVERED'));
    assert.ok(eventTypes(db, 'run').includes('INTERRUPTED_WORKTREE_RESET'));
  } finally {
    db.close();
  }
});

test('orchestrator uses a supplied backend pool and forwards worker and reviewer activity', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    if (spec.role === 'worker') {
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'pooled\n', 'utf8');
      return workerResult('completed', 'completed through pool');
    }
    assert.equal(spec.role, 'reviewer');
    return approvedReview();
  });
  const requested = [];
  const pool = {
    get: async (binding) => {
      requested.push(binding);
      return backend;
    },
    dispose: () => {}
  };
  try {
    await createPlannedRun(db, config);
    await runOrchestrator({
      config,
      db,
      runId: 'run',
      backends: pool
    });

    assert.equal(db.getRun('run').status, 'done');
    assert.deepEqual(requested.map((binding) => binding.agent), ['default-claude', 'default-claude']);
  } finally {
    db.close();
  }
});

test('orchestrator omits unavailable retry context after Git and result-file failures', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((spec) => {
    assert.equal(spec.role, 'worker');
    assert.doesNotMatch(spec.prompt, /Previous worker summary/);
    return workerResult('blocked', 'retry context was safely omitted');
  });
  try {
    const baseSha = await createPlannedRun(db, config);
    const nonGitWorktree = mkdtempSync(join(tmpdir(), 'agent-team-non-git-worktree-'));
    mkdirSync(join(config.workspace.stateDir, 'runs', 'run', 'results'), { recursive: true });
    writeFileSync(join(config.workspace.stateDir, 'runs', 'run', 'results', 'T001-worker-1.json'), '{not json', 'utf8');
    db.updateTask('run', 'T001', {
      status: 'changes_requested',
      phase: 'retry',
      attempts: 1,
      worktree: nonGitWorktree,
      branch: 'retry-context',
      startSha: baseSha
    });

    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    assert.equal(db.getTask('run', 'T001').status, 'blocked');
  } finally {
    db.close();
  }
});
