import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateDatabase } from '../dist/core/db.js';

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
  db.close();
});
