import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunnerConfig, TaskSpec } from './types.js';
import { changedFiles, currentHead } from './git.js';
import { checkPaths } from './path-policy.js';
import { assertAllowedCommand, runCommand } from './shell.js';

export interface VerificationResult {
  ok: boolean;
  changedFiles: string[];
  error?: string;
}

export async function verifyTaskWorktree(input: {
  worktree: string;
  task: TaskSpec;
  startSha: string;
  config: RunnerConfig;
  logPath: string;
}): Promise<VerificationResult> {
  mkdirSync(dirname(input.logPath), { recursive: true });
  const log = (text: string): void => appendFileSync(input.logPath, text, 'utf8');
  let state = await inspectTaskState(input);
  if (!state.ok) return state;
  for (const command of input.task.verificationCommands) {
    try {
      assertAllowedCommand(command, input.config.verification.allowedCommandPrefixes);
    } catch (error) {
      return { ok: false, changedFiles: state.changedFiles, error: String(error) };
    }
    log(`\n$ ${command}\n`);
    const code = await runCommand(command, input.worktree, log);
    const inspected = await inspectTaskState(input);
    if (!inspected.ok) {
      return code === 0 ? inspected : { ...inspected, error: `Verification command failed (${code}) and changed protected state: ${command}. ${inspected.error}` };
    }
    state = inspected;
    if (code !== 0) return { ok: false, changedFiles: state.changedFiles, error: `Verification command failed (${code}): ${command}` };
  }
  return state;
}

async function inspectTaskState(input: {
  worktree: string;
  task: TaskSpec;
  startSha: string;
}): Promise<VerificationResult> {
  const head = await currentHead(input.worktree);
  if (head !== input.startSha) {
    return { ok: false, changedFiles: [], error: `Worker changed Git history or committed directly. Expected HEAD ${input.startSha}, got ${head}.` };
  }
  const files = await changedFiles(input.worktree);
  if (files.length === 0 && !input.task.allowNoChanges) {
    return { ok: false, changedFiles: files, error: 'Worker produced no file changes.' };
  }
  const pathCheck = checkPaths(files, input.task.allowedPaths, input.task.blockedPaths);
  if (!pathCheck.ok) {
    return {
      ok: false,
      changedFiles: files,
      error: `Path policy failed. Outside allowed paths: ${pathCheck.invalid.join(', ') || 'none'}. Blocked paths: ${pathCheck.blocked.join(', ') || 'none'}.`
    };
  }
  return { ok: true, changedFiles: files };
}
