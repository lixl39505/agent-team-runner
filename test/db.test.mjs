import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateDatabase } from '../src/core/db.ts';

test('persists run and task state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-db-'));
  const db = new StateDatabase(join(dir, 'state.sqlite'));
  db.createRun({ id: 'demo', repoRoot: dir, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'abc', adapter: 'claude' });
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
  assert.deepEqual(db.listAgentExecutions('demo').map((entry) => ({ id: entry.agentId, status: entry.status, session: entry.sessionId })), [
    { id: 'T001-worker-1', status: 'completed', session: 'thread-1' }
  ]);
  assert.equal(db.getAgentExecution('demo', 'T001-worker-1').logPath, '/tmp/worker.log');
  db.updateAgentExecution('demo', 'T001-worker-1', {});
  assert.throws(() => db.getAgentExecution('demo', 'missing'), /not found/);
  db.close();
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
