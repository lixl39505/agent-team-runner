import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateIntegrationResult, validateReviewResult, validateWorkerResult } from '../src/core/validation.ts';
import { DEFAULT_CONFIG } from '../src/core/defaults.ts';
import { verifyTaskWorktree, runGlobalVerification } from '../src/core/verifier.ts';

function task(overrides = {}) {
  return {
    id: 'TASK_1', title: 'Task', description: 'Description', dependsOn: [], allowedPaths: ['src/**'],
    blockedPaths: [], acceptance: ['done'], verificationCommands: [],
    ...overrides
  };
}

function repository() {
  const repo = mkdtempSync(join(tmpdir(), 'agent-team-verifier-'));
  for (const args of [['init', '-q'], ['config', 'user.email', 'tests@example.test'], ['config', 'user.name', 'Tests']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(join(repo, 'README.md'), 'base\n');
  const committed = spawnSync('git', ['add', '.'], { cwd: repo, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  const commit = spawnSync('git', ['commit', '-qm', 'base'], { cwd: repo, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  return repo;
}

test('result validators preserve optional fields and reject every malformed result shape', () => {
  assert.deepEqual(validateWorkerResult({ status: 'blocked', blockedReason: 'waiting' }).blockedReason, 'waiting');
  assert.deepEqual(validateReviewResult({ decision: 'changes_requested', findings: [{ severity: 'low', file: 'a.ts', line: 1, message: 'note' }] }).findings[0], { severity: 'low', file: 'a.ts', line: 1, message: 'note' });
  assert.deepEqual(validateIntegrationResult({ status: 'failed', blockedReason: 'conflict' }).blockedReason, 'conflict');
  assert.throws(() => validateWorkerResult([]));
  assert.throws(() => validateReviewResult({ decision: 'approved', findings: [{}] }));
  assert.throws(() => validateIntegrationResult({ status: 'completed', testsRun: [1] }));
});

test('verification rejects unsafe commands and global verification handles failures without mutation', async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo, 'src.txt'), 'changed\n');
    const startSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const logs = mkdtempSync(join(tmpdir(), 'agent-team-verifier-logs-'));
    const config = { ...DEFAULT_CONFIG, verification: { ...DEFAULT_CONFIG.verification, allowedCommandPrefixes: ['node -e'], globalCommands: ['node -e "process.exit(1)"'] } };
    const unsafe = await verifyTaskWorktree({
      worktree: repo, task: task({ allowedPaths: ['src.txt'], verificationCommands: ['rm -rf /'] }), startSha, config,
      logPath: join(logs, 'unsafe.log')
    });
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.error, /not allowlisted|Unsafe shell syntax/);

    const failed = await verifyTaskWorktree({
      worktree: repo, task: task({ allowedPaths: ['src.txt'], verificationCommands: ['node -e "process.exit(2)"'] }), startSha, config,
      logPath: join(logs, 'failed.log')
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /Verification command failed \(2\)/);
    await assert.rejects(runGlobalVerification({ worktree: repo, config, logPath: join(logs, 'global.log') }), /Global verification failed \(1\)/);
    rmSync(logs, { recursive: true, force: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
