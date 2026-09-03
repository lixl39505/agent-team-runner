import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyTaskWorktree } from '../src/core/verifier.ts';

function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-team-verifier-isolation-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'allowed.txt'), 'base\n');
  writeFileSync(join(dir, 'mutate-task.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('outside.txt', 'escaped\\n');\n");
  writeFileSync(join(dir, 'mutate-fail.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('outside.txt', 'escaped\\n'); process.exit(1);\n");
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

test('task verification rejects files created outside the task path policy', async () => {
  const worktree = repository();
  const logs = mkdtempSync(join(tmpdir(), 'agent-team-verifier-logs-'));
  const startSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  writeFileSync(join(worktree, 'src', 'allowed.txt'), 'worker change\n');
  const result = await verifyTaskWorktree({
    worktree,
    startSha,
    task: {
      id: 'T1', title: 'test', description: 'test', dependsOn: [],
      allowedPaths: ['src/**'], blockedPaths: [], acceptance: [],
      verificationCommands: ['node mutate-task.mjs']
    },
    config: { verification: { allowedCommandPrefixes: ['node mutate-task.mjs'] } },
    logPath: join(logs, 'task-verification.log')
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Outside allowed paths: outside\.txt/);
});

test('task verification still inspects protected state after a nonzero exit', async () => {
  const worktree = repository();
  const logs = mkdtempSync(join(tmpdir(), 'agent-team-verifier-logs-'));
  const startSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  writeFileSync(join(worktree, 'src', 'allowed.txt'), 'worker change\n');
  const result = await verifyTaskWorktree({
    worktree,
    startSha,
    task: {
      id: 'T1', title: 'test', description: 'test', dependsOn: [],
      allowedPaths: ['src/**'], blockedPaths: [], acceptance: [],
      verificationCommands: ['node mutate-fail.mjs']
    },
    config: { verification: { allowedCommandPrefixes: ['node mutate-fail.mjs'] } },
    logPath: join(logs, 'task-verification.log')
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /failed \(1\) and changed protected state/);
});
