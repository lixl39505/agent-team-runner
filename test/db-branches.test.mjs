import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateDatabase } from '../src/core/db.ts';

test('database preserves null optional agent execution fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-db-branches-'));
  const db = new StateDatabase(join(directory, 'state.sqlite'));
  try {
    db.createRun({ id: 'run', repoRoot: directory, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'claude' });
    db.startAgentExecution({ runId: 'run', agentId: 'lead-1', role: 'lead', backend: 'claude', logPath: '/tmp/lead.log' });

    const execution = db.getAgentExecution('run', 'lead-1');
    assert.equal(execution.taskId, null);
    assert.equal(execution.model, null);
    assert.equal(execution.sessionId, null);
    assert.equal(execution.finishedAt, null);
  } finally {
    db.close();
  }
});

test('database refuses contract revisions for legacy runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-db-contract-'));
  const db = new StateDatabase(join(directory, 'state.sqlite'));
  try {
    db.createRun({ id: 'legacy', repoRoot: directory, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'cli' });
    assert.throws(() => db.appendContractRevision('legacy', '{}'), /has no execution contract/);
  } finally {
    db.close();
  }
});

test('database rolls back failed contract revisions and lease acquisitions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-db-rollback-'));
  const db = new StateDatabase(join(directory, 'state.sqlite'));
  try {
    db.createRun({
      id: 'contract-run', repoRoot: directory, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base',
      executionContractJson: '{"version":1}', adapter: 'cli'
    });
    db.db.prepare(`
      INSERT INTO execution_contract_revisions (run_id, revision, contract_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run('contract-run', 2, '{"version":2}', '2026-01-01T00:00:00.000Z');

    assert.throws(() => db.appendContractRevision('contract-run', '{"version":3}'), /UNIQUE constraint failed/);
    assert.equal(db.getRun('contract-run').contractRevision, 1);
  } finally {
    db.close();
  }
});

test('nested transactions roll back to savepoints and keep the connection usable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-db-nested-tx-'));
  const db = new StateDatabase(join(directory, 'state.sqlite'));
  try {
    assert.throws(() => db.transaction(() => {
      db.transaction(() => { throw new Error('inner boom'); });
    }), /inner boom/);
    // 嵌套 SAVEPOINT 回滚之后，连接的嵌套深度与新事务都必须恢复正常。
    db.createRun({
      id: 'after-nested', repoRoot: directory, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'cli'
    });
    assert.equal(db.getRun('after-nested').id, 'after-nested');
  } finally {
    db.close();
  }
});
