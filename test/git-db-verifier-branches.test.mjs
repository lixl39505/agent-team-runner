import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, currentHead, git } from '../src/core/git.ts';
import { StateDatabase } from '../src/core/db.ts';
import { verifyTaskWorktree } from '../src/core/verifier.ts';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-branches-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'file.txt'), 'base\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return root;
}

function task(overrides = {}) {
  return {
    id: 'T001',
    title: 'test task',
    description: 'test task',
    dependsOn: [],
    allowedPaths: ['src/**'],
    blockedPaths: [],
    acceptance: [],
    verificationCommands: [],
    ...overrides
  };
}

function createLegacyDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      goal_file TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      manifest_json TEXT,
      integration_branch TEXT,
      integration_worktree TEXT,
      integration_commit TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    ) STRICT;
  `);
  db.close();
}

test('git reports deterministic failures while allowing callers to inspect them', async () => {
  const root = repository();

  assert.deepEqual(await changedFiles(root), []);
  const permitted = await git(root, ['rev-parse', '--verify', 'does-not-exist'], true);
  assert.notEqual(permitted.code, 0);
  await assert.rejects(
    git(root, ['rev-parse', '--verify', 'does-not-exist']),
    /git rev-parse --verify does-not-exist failed/
  );
});

test('database migrates legacy runs and maps absent optional values to null', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-db-migration-'));
  const path = join(directory, 'state.sqlite');
  createLegacyDatabase(path);

  const db = new StateDatabase(path);
  const columns = db.db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name);
  assert.equal(columns.includes('roles_json'), true);

  db.createRun({ id: 'run', repoRoot: directory, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'codex' });
  const run = db.getRun('run');
  assert.equal(run.rolesJson, null);
  assert.equal(run.manifestJson, null);
  assert.equal(run.integrationBranch, null);
  assert.equal(run.error, null);

  db.updateRun('run', { rolesJson: '{"version":2}' });
  assert.equal(db.getRun('run').rolesJson, '{"version":2}');
  db.close();
});

test('database recovery only resets active task states', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-db-active-'));
  const db = new StateDatabase(join(directory, 'state.sqlite'));
  db.createRun({ id: 'run', repoRoot: directory, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'codex' });
  for (const id of ['running', 'verifying', 'reviewing', 'approved']) db.insertTask('run', task({ id }));
  db.updateTask('run', 'running', { status: 'running' });
  db.updateTask('run', 'verifying', { status: 'verifying' });
  db.updateTask('run', 'reviewing', { status: 'reviewing' });

  db.resetInterrupted('run');

  for (const id of ['running', 'verifying', 'reviewing']) {
    const recovered = db.getTask('run', id);
    assert.equal(recovered.status, 'changes_requested');
    assert.equal(recovered.phase, 'recovered');
  }
  assert.equal(db.getTask('run', 'approved').status, 'pending');
  assert.equal(
    db.db.prepare("SELECT count(*) AS count FROM events WHERE event_type = 'TASK_RECOVERED'").get().count,
    3
  );
  db.close();
});

test('task verification protects Git history before accepting path state', async () => {
  const worktree = repository();
  const logs = mkdtempSync(join(tmpdir(), 'agent-team-verifier-logs-'));
  const startSha = await currentHead(worktree);
  writeFileSync(join(worktree, 'src', 'file.txt'), 'committed directly\n');
  execFileSync('git', ['commit', '-am', 'direct commit'], { cwd: worktree });

  const result = await verifyTaskWorktree({
    worktree,
    task: task({ allowNoChanges: true }),
    startSha,
    config: { verification: { allowedCommandPrefixes: [] } },
    logPath: join(logs, 'verification.log')
  });

  assert.deepEqual(result.changedFiles, []);
  assert.match(result.error, new RegExp(`Expected HEAD ${startSha}`));
});

test('task verification rejects empty changes unless explicitly allowed', async () => {
  const worktree = repository();
  const logs = mkdtempSync(join(tmpdir(), 'agent-team-verifier-empty-'));
  const startSha = await currentHead(worktree);
  const input = {
    worktree,
    startSha,
    config: { verification: { allowedCommandPrefixes: [] } },
    logPath: join(logs, 'verification.log')
  };

  const rejected = await verifyTaskWorktree({ ...input, task: task() });
  assert.deepEqual(rejected, { ok: false, changedFiles: [], error: 'Worker produced no file changes.' });

  const allowed = await verifyTaskWorktree({ ...input, task: task({ allowNoChanges: true }) });
  assert.deepEqual(allowed, { ok: true, changedFiles: [] });
});
