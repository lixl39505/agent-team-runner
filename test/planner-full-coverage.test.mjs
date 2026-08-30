import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { StateDatabase } from '../src/core/db.ts';
import { planRun } from '../src/core/planner.ts';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-planner-full-coverage-'));
  writeFileSync(join(root, 'goal.md'), '# Goal\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Tests'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return root;
}

function configFor(repoRoot, overrides = {}) {
  const { workspace, retry, status, ...rest } = overrides;
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace, repoRoot, stateDir: join(repoRoot, '.state'), worktreesDir: join(repoRoot, '.worktrees'), ...workspace },
    retry: { ...DEFAULT_CONFIG.retry, ...retry },
    status: { ...DEFAULT_CONFIG.status, ...status },
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [] },
    ...rest
  };
}

class LeadBackend {
  id = 'claude';
  capabilities = { maxTurns: true, resumeSession: true };
  spec;

  constructor(completion) {
    this.completion = completion;
  }

  async discover() { return { backend: this.id, installed: true, authed: true }; }
  async listModels() { return []; }
  async probe() { return { ok: true, latencyMs: 1 }; }
  async openSession(spec) {
    this.spec = spec;
    return {
      async interrupt() {},
      async close() {},
      completion: this.completion
    };
  }
}

test('planner stops a retry after repeated signals while passing configured lead options', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot, {
    agents: { lead: { backend: 'claude', model: 'test-model', maxTurns: 2 } },
    defaultAgent: 'lead',
    retry: { maxPlanAttempts: 2 }
  });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new LeadBackend(async () => {
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    return { ok: true, output: null, timedOut: false, stalled: false };
  });
  const backends = { claude: backend, codex: backend, opencode: backend };
  const once = process.once;
  process.once = process.on;
  try {
    await assert.rejects(
      planRun({ config, db, goalFile: 'goal.md', runId: 'interrupted', backends }),
      /Planning interrupted by user/
    );
    assert.equal(backend.spec.model, 'test-model');
    assert.equal(backend.spec.maxTurns, 2);
    assert.equal(db.getRun('interrupted').status, 'failed');
  } finally {
    process.once = once;
    process.exitCode = undefined;
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('planner creates and disposes its managed backend pool when none is supplied', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot, { retry: { maxPlanAttempts: 0 } });
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  try {
    await assert.rejects(
      planRun({ config, db, goalFile: 'goal.md', runId: 'managed-pool' }),
      /Lead could not produce a valid manifest/
    );
    assert.equal(db.getRun('managed-pool').status, 'failed');
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('planner uses a supplied backend pool and forwards lead activity events', async () => {
  const repoRoot = repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new LeadBackend(async () => ({
    ok: true,
    output: {
      version: 1,
      title: 'Pool plan',
      summary: 'A valid plan from a pooled backend.',
      tasks: [{
        id: 'T001', title: 'Task', description: 'Do the task.', dependsOn: [],
        allowedPaths: ['src/**'], blockedPaths: [], acceptance: ['done'], verificationCommands: []
      }]
    },
    timedOut: false,
    stalled: false
  }));
  const requested = [];
  const events = [];
  const pool = {
    get: async (binding) => {
      requested.push(binding);
      return backend;
    },
    dispose: () => {}
  };
  try {
    const runId = await planRun({
      config,
      db,
      goalFile: 'goal.md',
      runId: 'pooled-plan',
      backends: pool,
      onAgentEvent: (execution, event) => events.push([execution.agentId, event.type])
    });

    assert.equal(runId, 'pooled-plan');
    assert.equal(requested.length, 1);
    assert.deepEqual(events, [['lead-1', 'activity']]);
    assert.equal(db.getRun(runId).status, 'planned');
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
