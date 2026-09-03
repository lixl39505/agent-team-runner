import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/core/defaults.ts';
import { StateDatabase } from '../src/core/db.ts';
import { currentHead, git } from '../src/core/git.ts';
import { snapshotAgents } from '../src/agent/registry.ts';
import { runOrchestrator } from '../src/core/orchestrator.ts';

async function repository() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-coverage-'));
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
    retry: { ...DEFAULT_CONFIG.retry, maxWorkerAttempts: 1, maxReviewCycles: 2, ...retry },
    status: { ...DEFAULT_CONFIG.status, ...status },
    integration: { ...DEFAULT_CONFIG.integration },
    verification: { ...DEFAULT_CONFIG.verification },
    // 跨厂商强制验收：reviewer 落在另一个后端（测试池把所有 backend id 指到同一个假后端）。
    agents: { ...DEFAULT_CONFIG.agents, 'default-codex': { backend: 'codex' } },
    roles: { reviewer: 'default-codex' },
    ...rest
  };
}

function task(id = 'T001', extra = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: 'Update the feature file.',
    dependsOn: [],
    allowedPaths: ['src/**'],
    blockedPaths: [],
    acceptance: ['feature is updated'],
    verificationCommands: [],
    ...extra
  };
}

class Backend {
  id = 'claude';
  capabilities = { maxTurns: true, resumeSession: true };

  constructor(handler) {
    this.handler = handler;
    this.specs = [];
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

function pool(backend) {
  return { claude: backend, codex: backend, opencode: backend };
}

async function planned(db, config, tasks = [task()], manifestTasks = tasks) {
  const baseSha = await currentHead(config.workspace.repoRoot);
  db.createRun({ id: 'run', repoRoot: config.workspace.repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha, adapter: 'claude' });
  for (const spec of tasks) db.insertTask('run', spec);
  db.updateRun('run', {
    status: 'planned',
    manifestJson: JSON.stringify({ version: 1, title: 'Coverage', summary: 'coverage', tasks: manifestTasks }),
    rolesJson: JSON.stringify(snapshotAgents(config))
  });
  return baseSha;
}

function worker(status = 'blocked', extra = {}) {
  return { status, summary: 'worker result', testsRun: [], knownRisks: [], ...extra };
}

test('orchestrator exercises worker fallback paths and retry context persistence', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot, { retry: { maxWorkerAttempts: 2 } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new Backend((spec) => {
    assert.equal(spec.role, 'worker');
    spec.onEvent({ type: 'progress' });
    spec.onEvent({ type: 'progress' });
    assert.match(spec.prompt, /untracked files/);
    return worker('blocked');
  });
  try {
    const baseSha = await planned(db, config);
    const worktree = join(config.workspace.worktreesDir, basename(repoRoot), 'run', 'T001');
    mkdirSync(join(config.workspace.worktreesDir, basename(repoRoot), 'run'), { recursive: true });
    await git(repoRoot, ['worktree', 'add', '-q', '-b', 'coverage-retry', worktree, baseSha]);
    writeFileSync(join(worktree, 'src', 'feature.txt'), 'changed\n', 'utf8');
    writeFileSync(join(worktree, 'src', 'untracked.txt'), 'untracked\n', 'utf8');
    mkdirSync(join(config.workspace.stateDir, 'runs', 'run', 'results'), { recursive: true });
    writeFileSync(join(config.workspace.stateDir, 'runs', 'run', 'results', 'T001-worker-1.json'), '{"summary":7}', 'utf8');
    db.updateTask('run', 'T001', { status: 'changes_requested', phase: 'retry', attempts: 1, worktree, branch: 'coverage-retry', startSha: baseSha });

    await runOrchestrator({ config, db, runId: 'run', backends: pool(backend) });

    assert.equal(db.getTask('run', 'T001').lastError, 'worker result');
  } finally {
    db.close();
  }
});

test('orchestrator handles missing worker and reviewer fallback values', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  let calls = 0;
  const backend = new Backend((spec) => {
    calls += 1;
    if (spec.role === 'worker') {
      writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'changed\n', 'utf8');
      return worker('completed');
    }
    return { ok: false, output: null, timedOut: false, stalled: false };
  });
  try {
    await planned(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: pool(backend) });
    assert.equal(calls, 2);
    assert.match(db.getTask('run', 'T001').lastError, /Reviewer failed: no structured output/);
  } finally {
    db.close();
  }
});

test('orchestrator records worker and verification fallback failures', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new Backend(() => worker('completed'));
  try {
    await planned(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: pool(backend) });
    assert.match(db.getTask('run', 'T001').lastError, /Worker produced no file changes/);
  } finally {
    db.close();
  }
});

test('orchestrator uses a blocked worker summary when no explicit reason is supplied', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new Backend(() => worker('blocked'));
  try {
    await planned(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: pool(backend) });
    assert.equal(db.getTask('run', 'T001').lastError, 'worker result');
  } finally {
    db.close();
  }
});

test('orchestrator records non-terminal review feedback for a clean retry', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot, { retry: { maxWorkerAttempts: 2 } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  let workerCalls = 0;
  const backend = new Backend((spec) => {
    if (spec.role === 'worker') {
      workerCalls += 1;
      if (workerCalls === 1) writeFileSync(join(spec.cwd, 'src', 'feature.txt'), 'changed\n', 'utf8');
      return worker(workerCalls === 1 ? 'completed' : 'blocked');
    }
    return { decision: 'changes_requested', summary: 'retry this', findings: [], requiredChanges: [] };
  });
  try {
    await planned(db, config);
    await runOrchestrator({ config, db, runId: 'run', backends: pool(backend) });
    assert.equal(db.getTask('run', 'T001').reviewCycles, 1);
  } finally {
    db.close();
  }
});
