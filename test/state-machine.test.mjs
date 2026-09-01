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
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-state-machine-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'feature.txt'), 'base\n', 'utf8');
  writeFileSync(join(repoRoot, 'goal.md'), '# Test goal\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'test']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  return repoRoot;
}

function configFor(repoRoot) {
  const name = basename(repoRoot);
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace, repoRoot, stateDir: join(tmpdir(), `${name}-state`), worktreesDir: join(tmpdir(), `${name}-worktrees`) },
    concurrency: 1,
    retry: { ...DEFAULT_CONFIG.retry, maxWorkerAttempts: 2, maxReviewCycles: 2 },
    integration: { ...DEFAULT_CONFIG.integration },
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [] }
  };
}

function workerResult(summary) {
  return {
    status: 'completed', summary, testsRun: [], knownRisks: []
  };
}

function approvedReview() {
  return { decision: 'approved', summary: 'looks good', findings: [], requiredChanges: [] };
}

function task(overrides = {}) {
  return {
    id: 'T001', title: 'Change feature', description: 'Update the feature file.',
    dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [],
    acceptance: ['feature is updated'], verificationCommands: [], ...overrides
  };
}

class ScriptBackend {
  id = 'claude';
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
      completion: async () => ({
        ok: true,
        output: await this.handler(spec),
        timedOut: false,
        stalled: false
      })
    };
  }
}

function backendPool(backend) {
  return { claude: backend, codex: backend, opencode: backend };
}

async function createPlannedRun(db, config, manifest, id = 'run', resolvedSkills = new Map()) {
  const baseSha = await currentHead(config.workspace.repoRoot);
  db.createRun({ id, repoRoot: config.workspace.repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'claude' });
  for (const spec of manifest.tasks) db.insertTask(id, spec, resolvedSkills.get(spec.id));
  db.updateRun(id, {
    status: 'planned',
    manifestJson: JSON.stringify(manifest),
    rolesJson: JSON.stringify(snapshotAgents(config))
  });
}

function eventTypes(db, runId) {
  return db.db.prepare('SELECT event_type FROM events WHERE run_id = ? ORDER BY id').all(runId).map((row) => row.event_type);
}

test('orchestrator retries reviewer feedback and integrates the approved task', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const persistedSkills = [{
    name: 'tdd', role: 'worker', source: 'project', path: '/stored/tdd/SKILL.md', sha256: 'persisted-sha', content: 'Use the stored snapshot.'
  }];
  const manifest = {
    version: 1, title: 'Run', summary: 'test run',
    tasks: [task({ implementationSkills: [{ name: 'tdd', role: 'worker', required: true, source: 'project' }] })]
  };
  let workerAttempts = 0;
  let reviewAttempts = 0;
  const backend = new ScriptBackend((spec) => {
    if (spec.role === 'worker') {
      workerAttempts += 1;
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), workerAttempts === 1 ? 'first\n' : 'fixed\n', 'utf8');
      return workerResult(workerAttempts === 1 ? 'first pass' : 'fixed pass');
    }
    if (spec.role === 'reviewer') {
      reviewAttempts += 1;
      return reviewAttempts === 1
        ? { decision: 'changes_requested', summary: 'needs fix', findings: [], requiredChanges: ['fix the feature'] }
        : approvedReview();
    }
    throw new Error(`unexpected role: ${spec.role}`);
  });
  try {
    await createPlannedRun(db, config, manifest, 'run', new Map([['T001', persistedSkills]]));
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const record = db.getTask('run', 'T001');
    assert.equal(db.getRun('run').status, 'done');
    assert.equal(record.status, 'approved');
    assert.equal(record.attempts, 2);
    assert.equal(record.reviewCycles, 2);
    assert.ok(record.commitSha);
    assert.equal(workerAttempts, 2);
    assert.equal(reviewAttempts, 2);
    const workerPrompts = backend.specs.filter((spec) => spec.role === 'worker').map((spec) => spec.prompt);
    assert.match(workerPrompts[1], /Reviewer feedback \(verbatim\).*needs fix/s);
    assert.match(workerPrompts[1], /Previous worker summary.*first pass/s);
    assert.match(workerPrompts[0], /Use the stored snapshot/);
    assert.match(workerPrompts[0], /sha256:persisted-sha/);
    assert.equal(readFileSync(join(db.getRun('run').integrationWorktree, 'src', 'feature.txt'), 'utf8'), 'fixed\n');
    assert.ok(eventTypes(db, 'run').includes('CHANGES_REQUESTED'));
    assert.ok(eventTypes(db, 'run').includes('INTEGRATION_COMPLETED'));
  } finally {
    db.close();
  }
});

test('orchestrator waits for dependencies and injects their commits into worktrees', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const manifest = {
    version: 1,
    title: 'Dependencies',
    summary: 'ordered tasks',
    tasks: [
      task({ id: 'T001', title: 'First', allowedPaths: ['src/one.txt'] }),
      task({ id: 'T002', title: 'Second', dependsOn: ['T001'], allowedPaths: ['src/two.txt'] })
    ]
  };
  const workers = [];
  const backend = new ScriptBackend((spec) => {
    if (spec.role === 'reviewer') return approvedReview();
    if (spec.role !== 'worker') throw new Error(`unexpected role: ${spec.role}`);
    const id = spec.prompt.includes('"id": "T001"') ? 'T001' : 'T002';
    workers.push(id);
    if (id === 'T001') {
      writeFileSync(join(spec.cwd, 'src', 'one.txt'), 'one\n', 'utf8');
    } else {
      assert.equal(readFileSync(join(spec.cwd, 'src', 'one.txt'), 'utf8'), 'one\n');
      writeFileSync(join(spec.cwd, 'src', 'two.txt'), 'two\n', 'utf8');
    }
    return workerResult(`completed ${id}`);
  });
  try {
    await createPlannedRun(db, config, manifest);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    assert.deepEqual(workers, ['T001', 'T002']);
    assert.equal(db.getRun('run').status, 'done');
    const integration = db.getRun('run').integrationWorktree;
    assert.equal(readFileSync(join(integration, 'src', 'one.txt'), 'utf8'), 'one\n');
    assert.equal(readFileSync(join(integration, 'src', 'two.txt'), 'utf8'), 'two\n');
  } finally {
    db.close();
  }
});

test('orchestrator records a failed run when global integration verification fails', async () => {
  const repoRoot = await repository();
  const config = {
    ...configFor(repoRoot),
    verification: {
      ...DEFAULT_CONFIG.verification,
      allowedCommandPrefixes: ['node -e'],
      globalCommands: ['node -e "process.exit(1)"']
    }
  };
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const manifest = { version: 1, title: 'Run', summary: 'test run', tasks: [task()] };
  const backend = new ScriptBackend((spec) => {
    if (spec.role === 'worker') {
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'changed\n', 'utf8');
      return workerResult('completed');
    }
    if (spec.role === 'reviewer') return approvedReview();
    throw new Error(`unexpected role: ${spec.role}`);
  });
  try {
    await createPlannedRun(db, config, manifest);
    await assert.rejects(
      runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) }),
      /Global verification failed \(1\)/
    );
    assert.equal(db.getRun('run').status, 'failed');
    assert.equal(eventTypes(db, 'run').includes('RUN_FAILED'), true);
  } finally {
    db.close();
  }
});

test('orchestrator blocks out-of-scope worker changes before review', async () => {
  const repoRoot = await repository();
  const config = { ...configFor(repoRoot), retry: { ...DEFAULT_CONFIG.retry, maxWorkerAttempts: 1 } };
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const manifest = { version: 1, title: 'Run', summary: 'test run', tasks: [task()] };
  const backend = new ScriptBackend((spec) => {
    if (spec.role !== 'worker') throw new Error(`unexpected role: ${spec.role}`);
    writeFileSync(join(spec.cwd, 'outside.txt'), 'escaped\n', 'utf8');
    return workerResult('wrote outside the task boundary');
  });
  try {
    await createPlannedRun(db, config, manifest);
    await runOrchestrator({ config, db, runId: 'run', backends: backendPool(backend) });

    const record = db.getTask('run', 'T001');
    assert.equal(db.getRun('run').status, 'needs_attention');
    assert.equal(record.status, 'failed');
    assert.equal(record.commitSha, null);
    assert.match(record.lastError, /Outside allowed paths: outside\.txt/);
    assert.equal(eventTypes(db, 'run').includes('REVIEW_STARTED'), false);
  } finally {
    db.close();
  }
});
