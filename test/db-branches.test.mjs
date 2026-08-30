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
