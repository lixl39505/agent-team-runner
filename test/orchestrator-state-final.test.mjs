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

async function repository() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-state-final-'));
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

function configFor(repoRoot) {
  const name = basename(repoRoot);
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace, repoRoot, stateDir: join(tmpdir(), `${name}-state`), worktreesDir: join(tmpdir(), `${name}-worktrees`) },
    concurrency: 1,
    agents: {
      'task-worker': { backend: 'codex', model: 'worker-model' },
      'review-agent': { backend: 'opencode', model: 'review-model' }
    },
    defaultAgent: 'task-worker',
    roles: { reviewer: 'review-agent' },
    verification: {
      ...DEFAULT_CONFIG.verification,
      allowedCommandPrefixes: [...DEFAULT_CONFIG.verification.allowedCommandPrefixes, 'git status']
    }
  };
}

function task(id, dependsOn = [], extra = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: `Implement ${id}.`,
    dependsOn,
    allowedPaths: ['src/**'],
    blockedPaths: [],
    acceptance: ['implementation is present'],
    verificationCommands: [],
    ...extra
  };
}

function workerResult() {
  return {
    status: 'completed',
    summary: 'implemented leaf task',
    testsRun: [],
    knownRisks: []
  };
}

function approvedReview() {
  return { decision: 'approved', summary: 'reviewed', findings: [], requiredChanges: [] };
}

class ScriptBackend {
  capabilities = { maxTurns: true, resumeSession: true };
  specs = [];

  constructor(id, handler) {
    this.id = id;
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

async function approvedCommit(repoRoot, baseSha, branch, file, content) {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-state-seed-'));
  const worktree = join(root, 'worktree');
  await git(repoRoot, ['worktree', 'add', '-q', '-b', branch, worktree, baseSha]);
  writeFileSync(join(worktree, 'src', file), content, 'utf8');
  await git(worktree, ['add', 'src']);
  await git(worktree, ['commit', '-q', '-m', branch]);
  return currentHead(worktree);
}

test('orchestrator preserves bound state through verification, review, and recursive dependencies', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const approval = async () => 'once';
  const userInput = async () => ({});
  const worker = new ScriptBackend('codex', (spec) => {
    assert.equal(spec.role, 'worker');
    assert.equal(readFileSync(join(spec.cwd, 'src', 'root.txt'), 'utf8'), 'root\n');
    assert.equal(readFileSync(join(spec.cwd, 'src', 'middle.txt'), 'utf8'), 'middle\n');
    writeFileSync(join(spec.cwd, 'src', 'leaf.txt'), 'leaf\n', 'utf8');
    return workerResult();
  });
  const reviewer = new ScriptBackend('opencode', (spec) => {
    assert.equal(spec.role, 'reviewer');
    return approvedReview();
  });
  try {
    const baseSha = await currentHead(repoRoot);
    const root = task('T001');
    const middle = task('T002', ['T001']);
    const leaf = task('T003', ['T002'], { agent: 'task-worker', verificationCommands: ['git status --short'] });
    const rootCommit = await approvedCommit(repoRoot, baseSha, 'state-root', 'root.txt', 'root\n');
    const middleCommit = await approvedCommit(repoRoot, baseSha, 'state-middle', 'middle.txt', 'middle\n');
    const manifest = { version: 1, title: 'State final', summary: 'local script backends only', tasks: [root, middle, leaf] };
    db.createRun({ id: 'run', repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'codex' });
    for (const spec of manifest.tasks) db.insertTask('run', spec);
    db.updateRun('run', { status: 'planned', manifestJson: JSON.stringify(manifest), rolesJson: JSON.stringify(snapshotAgents(config)) });
    db.updateTask('run', 'T001', { status: 'approved', phase: 'done', commitSha: rootCommit });
    db.updateTask('run', 'T002', { status: 'approved', phase: 'done', commitSha: middleCommit });

    await runOrchestrator({
      config,
      db,
      runId: 'run',
      backends: { claude: worker, codex: worker, opencode: reviewer },
      requestApproval: approval,
      requestUserInput: userInput
    });

    const runDir = join(config.workspace.stateDir, 'runs', 'run');
    const started = db.db.prepare("SELECT payload_json FROM events WHERE run_id = ? AND event_type = 'WORKER_STARTED'").get('run');
    assert.deepEqual(JSON.parse(started.payload_json), { attempts: 1, agent: 'task-worker', backend: 'codex', model: 'worker-model' });
    assert.equal(db.getRun('run').status, 'done');
    assert.equal(db.getTask('run', 'T003').status, 'approved');
    assert.deepEqual(JSON.parse(db.getTask('run', 'T003').reviewJson), approvedReview());
    assert.equal(readFileSync(join(db.getRun('run').integrationWorktree, 'src', 'leaf.txt'), 'utf8'), 'leaf\n');
    assert.equal(existsSync(join(runDir, 'logs', 'T003-verification-1.log')), true);
    assert.equal(existsSync(join(runDir, 'logs', 'T003-review-1.log')), true);
    assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'reviews', 'T003-review-1.json'), 'utf8')), approvedReview());
    for (const backend of [worker, reviewer]) {
      assert.equal(await backend.specs[0].requestApproval({ backend: 'test', tool: 'test', kind: 'read' }), 'once');
      assert.deepEqual(await backend.specs[0].requestUserInput({ backend: 'test', questions: [] }), {});
    }
    assert.equal(worker.specs[0].model, 'worker-model');
    assert.equal(reviewer.specs[0].model, 'review-model');
  } finally {
    db.close();
  }
});
