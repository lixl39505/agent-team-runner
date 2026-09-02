import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { StateDatabase } from '../src/core/db.ts';

test('persists run and task state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-db-'));
  const db = new StateDatabase(join(dir, 'state.sqlite'));
  db.createRun({ id: 'demo', repoRoot: dir, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' });
  const run = db.getRun('demo');
  assert.equal(run.projectId, null);
  assert.equal(run.projectPolicyRevisionId, null);
  assert.equal(run.executionContractJson, null);
  db.insertTask('demo', {
    id: 'T001', title: 'task', description: 'task', dependsOn: [],
    allowedPaths: ['src/**'], blockedPaths: [], acceptance: ['works'], verificationCommands: []
  });
  db.updateTask('demo', 'T001', { status: 'approved', commitSha: 'def' });
  assert.equal(db.getTask('demo', 'T001').commitSha, 'def');
  assert.equal(db.listTasks('demo').length, 1);
  const taskColumns = db.db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name);
  assert.equal(taskColumns.includes('pid'), false);
  db.startAgentExecution({ runId: 'demo', agentId: 'T001-worker-1', taskId: 'T001', role: 'worker', backend: 'codex', model: 'gpt-5', logPath: '/tmp/worker.log' });
  db.updateAgentExecution('demo', 'T001-worker-1', { sessionId: 'thread-1', status: 'completed', finishedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(db.getAgentExecution('demo', 'T001-worker-1').logPath, '/tmp/worker.log');
  db.updateAgentExecution('demo', 'T001-worker-1', {});
  assert.throws(() => db.getAgentExecution('demo', 'missing'), /not found/);
  db.close();
});

test('migrates existing databases with execution provenance columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-db-migration-'));
  const path = join(dir, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      goal_file TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      manifest_json TEXT,
      roles_json TEXT,
      integration_branch TEXT,
      integration_worktree TEXT,
      integration_commit TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    ) STRICT;
    INSERT INTO runs VALUES (
      'legacy', '/repo', 'goal.md', 'HEAD', 'abc', 'claude', 'done', NULL, NULL,
      NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    );
  `);
  legacy.close();

  const db = new StateDatabase(path);
  try {
    const columns = db.db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name);
    assert.equal(columns.includes('project_id'), true);
    assert.equal(columns.includes('project_policy_revision_id'), true);
    assert.equal(columns.includes('execution_contract_json'), true);
    const run = db.getRun('legacy');
    assert.equal(run.projectId, null);
    assert.equal(run.projectPolicyRevisionId, null);
    assert.equal(run.executionContractJson, null);
  } finally {
    db.close();
  }
});

test('resetInterrupted marks active tasks for a clean recovered attempt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-db-recovery-'));
  const db = new StateDatabase(join(dir, 'state.sqlite'));
  db.createRun({ id: 'demo', repoRoot: dir, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' });
  db.insertTask('demo', {
    id: 'T001', title: 'task', description: 'task', dependsOn: [],
    allowedPaths: ['src/**'], blockedPaths: [], acceptance: ['works'], verificationCommands: []
  });
  db.updateTask('demo', 'T001', { status: 'running', phase: 'worker-active' });
  db.resetInterrupted('demo');
  const task = db.getTask('demo', 'T001');
  assert.equal(task.status, 'changes_requested');
  assert.equal(task.phase, 'recovered');
  assert.match(task.lastError, /discarded before retrying/);
  db.close();
});

test('lists durable events as ordered JSON records with bounded cursor pagination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-db-events-'));
  const db = new StateDatabase(join(dir, 'state.sqlite'));
  try {
    db.createRun({ id: 'events', repoRoot: dir, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' });
    db.addEvent('events', 'T001', 'JSON_EVENT', { nested: [true, 2] });
    db.addEvent('events', null, 'NULL_EVENT', null);
    db.addEvent('events', null, 'MISSING_PAYLOAD');

    const firstPage = db.listEvents('events', 0, 2);
    assert.deepEqual(firstPage.map((event) => ({
      runId: event.runId,
      taskId: event.taskId,
      eventType: event.eventType,
      payload: event.payload
    })), [
      { runId: 'events', taskId: null, eventType: 'RUN_CREATED', payload: { id: 'events', repoRoot: dir, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' } },
      { runId: 'events', taskId: 'T001', eventType: 'JSON_EVENT', payload: { nested: [true, 2] } }
    ]);
    assert.ok(firstPage[0].id < firstPage[1].id);
    assert.ok(Date.parse(firstPage[0].createdAt));
    const secondPage = db.listEvents('events', firstPage[1].id, 1);
    assert.deepEqual(secondPage, [{
      id: firstPage[1].id + 1,
      runId: 'events',
      taskId: null,
      eventType: 'NULL_EVENT',
      payload: null,
      createdAt: secondPage[0].createdAt
    }]);
    assert.deepEqual(db.listEvents('events', secondPage[0].id), [{
      id: secondPage[0].id + 1,
      runId: 'events',
      taskId: null,
      eventType: 'MISSING_PAYLOAD',
      payload: null,
      createdAt: db.listEvents('events', secondPage[0].id)[0].createdAt
    }]);
    assert.equal(db.listEvents('events')[0].id, firstPage[0].id);
    assert.deepEqual(db.listEvents('events', 999), []);
    assert.throws(() => db.listEvents('events', -1), /afterEventId/);
    assert.throws(() => db.listEvents('events', 0.5), /afterEventId/);
    assert.throws(() => db.listEvents('events', 0, 0), /limit/);
    assert.throws(() => db.listEvents('events', 0, 1001), /limit/);
  } finally {
    db.close();
  }
});

test('replaces task specs and reads legacy task rows without resolved skills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-db-task-spec-'));
  const db = new StateDatabase(join(dir, 'state.sqlite'));
  try {
    db.createRun({ id: 'replace', repoRoot: dir, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' });
    const original = { id: 'T001', title: 'first', description: 'first', dependsOn: [], allowedPaths: [], blockedPaths: [], acceptance: [], verificationCommands: [] };
    db.insertTask('replace', original);
    db.replaceTaskSpec('replace', { ...original, title: 'second' });
    assert.equal(db.getTask('replace', 'T001').title, 'second');
    assert.equal(db.getTask('replace', 'T001').resolvedSkillsJson, '[]');
  } finally {
    db.close();
  }
});

test('reads null resolved skills JSON from a legacy task row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-db-null-skills-'));
  const path = join(dir, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE tasks (
      run_id TEXT, task_id TEXT, title TEXT, spec_json TEXT, resolved_skills_json TEXT,
      status TEXT, phase TEXT, branch TEXT, worktree TEXT, start_sha TEXT, commit_sha TEXT,
      attempts INTEGER, review_cycles INTEGER, last_error TEXT, review_json TEXT,
      created_at TEXT, updated_at TEXT, finished_at TEXT
    );
    INSERT INTO tasks VALUES (
      'legacy', 'T001', 'task', '{}', NULL, 'pending', NULL, NULL, NULL, NULL, NULL,
      0, 0, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    );
  `);
  legacy.close();

  const db = new StateDatabase(path);
  try {
    assert.equal(db.getTask('legacy', 'T001').resolvedSkillsJson, '[]');
  } finally {
    db.close();
  }
});

