import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyTaskWorktree } from '../src/core/verifier.ts';

function repository() {
  const worktree = mkdtempSync(join(tmpdir(), 'agent-team-verifier-coverage-'));
  mkdirSync(join(worktree, 'src'));
  writeFileSync(join(worktree, 'src', 'blocked.txt'), 'base\n');
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktree });
  execFileSync('git', ['add', '.'], { cwd: worktree });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: worktree });
  return worktree;
}

test('task verification reports blocked-only path policy failures', async () => {
  const worktree = repository();
  const logs = mkdtempSync(join(tmpdir(), 'agent-team-verifier-logs-'));
  const startSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  writeFileSync(join(worktree, 'src', 'blocked.txt'), 'changed\n');

  const result = await verifyTaskWorktree({
    worktree,
    startSha,
    task: {
      id: 'T1', title: 'test', description: 'test', dependsOn: [],
      allowedPaths: ['src/**'], blockedPaths: ['src/blocked.txt'], acceptance: [], verificationCommands: []
    },
    config: { verification: { allowedCommandPrefixes: [] } },
    logPath: join(logs, 'verification.log')
  });

  assert.deepEqual(result, {
    ok: false,
    changedFiles: ['src/blocked.txt'],
    error: 'Path policy failed. Outside allowed paths: none. Blocked paths: src/blocked.txt.'
  });
});
