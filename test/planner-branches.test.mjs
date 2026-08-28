import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { StateDatabase } from '../src/core/db.ts';
import { git } from '../src/core/git.ts';
import { planRun } from '../src/core/planner.ts';

async function repository() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-team-planner-branches-'));
  writeFileSync(join(repoRoot, 'goal.md'), '# Goal\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'test']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  return repoRoot;
}

function configFor(repoRoot, maxPlanAttempts = 2) {
  return {
    ...DEFAULT_CONFIG,
    workspace: { ...DEFAULT_CONFIG.workspace, repoRoot, stateDir: join(tmpdir(), `${repoRoot.split('/').at(-1)}-state`), worktreesDir: join(tmpdir(), `${repoRoot.split('/').at(-1)}-worktrees`) },
    retry: { ...DEFAULT_CONFIG.retry, maxPlanAttempts },
    verification: { ...DEFAULT_CONFIG.verification, globalCommands: [] }
  };
}

function manifest() {
  return {
    version: 1,
    title: 'Plan',
    summary: 'test plan',
    tasks: [{
      id: 'T001', title: 'Change feature', description: 'Update the feature file.',
      dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [],
      acceptance: ['feature is updated'], verificationCommands: []
    }]
  };
}

class ScriptBackend {
  id = 'claude';
  capabilities = { maxTurns: true, resumeSession: true };
  calls = 0;

  constructor(handler) {
    this.handler = handler;
  }

  async discover() { return { backend: this.id, installed: true, authed: true }; }
  async listModels() { return []; }
  async probe() { return { ok: true, latencyMs: 1 }; }

  async openSession(spec) {
    assert.equal(spec.role, 'lead');
    this.calls += 1;
    return {
      async interrupt() {},
      async close() {},
      completion: async () => this.handler(this.calls)
    };
  }
}

function backendPool(backend) {
  return { claude: backend, codex: backend, opencode: backend };
}

function eventTypes(db, runId) {
  return db.db.prepare('SELECT event_type FROM events WHERE run_id = ? ORDER BY id').all(runId).map((row) => row.event_type);
}

test('planner retries after a lead produces no structured output', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend((attempt) => attempt === 1
    ? { ok: true, output: null, timedOut: false, stalled: false }
    : { ok: true, output: manifest(), timedOut: false, stalled: false });
  try {
    const runId = await planRun({ config, db, goalFile: 'goal.md', runId: 'plan-retry', backends: backendPool(backend) });

    assert.equal(runId, 'plan-retry');
    assert.equal(backend.calls, 2);
    assert.equal(db.getRun(runId).status, 'planned');
    assert.equal(db.listTasks(runId).length, 1);
    assert.equal(eventTypes(db, runId).includes('PLAN_VALIDATION_FAILED'), false);
  } finally {
    db.close();
  }
});

test('planner records a failed run after every lead retry has no output', async () => {
  const repoRoot = await repository();
  const config = configFor(repoRoot);
  const db = new StateDatabase(join(config.workspace.stateDir, 'state.sqlite'));
  const backend = new ScriptBackend(() => ({
    ok: false, output: null, error: 'lead backend unavailable', timedOut: false, stalled: false
  }));
  try {
    await assert.rejects(
      planRun({ config, db, goalFile: 'goal.md', runId: 'plan-failure', backends: backendPool(backend) }),
      /Lead could not produce a valid manifest: Lead failed: lead backend unavailable/
    );

    assert.equal(backend.calls, 2);
    assert.equal(db.getRun('plan-failure').status, 'failed');
    assert.match(db.getRun('plan-failure').error, /Lead could not produce a valid manifest/);
    assert.equal(db.listTasks('plan-failure').length, 0);
    assert.ok(eventTypes(db, 'plan-failure').includes('PLAN_FAILED'));
  } finally {
    db.close();
  }
});
