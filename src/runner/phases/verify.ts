// Mechanical verification gate: run each verification command in the
// worktree (argv, allowlisted), then assert diff scope against the task's
// path policy and that HEAD did not move unexpectedly.

import { runCommand } from '../../core/shell.ts';
import { worktreeChangedFiles, currentHead } from '../../core/git.ts';
import { isPathAllowed, matchAny, ATEAM_INTERNAL_PATTERNS } from '../../core/path-policy.ts';
import type { TaskRecord } from '../../core/types.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface VerificationCommandResult {
  command: string;
  ok: boolean;
  exitCode: number;
  output: string;
}

export interface VerificationOutcome {
  ok: boolean;
  commands: VerificationCommandResult[];
  violations: string[];
  diffFiles: string[];
  headBefore: string;
  headAfter: string;
  logPath: string | null;
}

/** Run the full mechanical gate for a task inside its worktree. */
export async function verifyTaskWork(
  opts: {
    worktreePath: string;
    task: TaskRecord;
    allowlist: readonly string[];
    baseSha: string;
    timeoutMs?: number;
    logDir?: string;
  },
): Promise<VerificationOutcome> {
  const { worktreePath, task, allowlist } = opts;
  const headBefore = await currentHead(worktreePath);
  const commands: VerificationCommandResult[] = [];

  for (const command of task.spec.verificationCommands ?? []) {
    const res = await runCommand(command, { cwd: worktreePath, allowlist, timeoutMs: opts.timeoutMs });
    commands.push({ command, ok: res.ok, exitCode: res.exitCode, output: res.stdout + res.stderr });
    if (!res.ok) break;
  }

  const diffFiles = await worktreeChangedFiles(worktreePath, opts.baseSha);
  const violations: string[] = [];
  for (const file of diffFiles) {
    // .ateam/** is runner-owned bookkeeping, never a policy violation
    if (matchAny(ATEAM_INTERNAL_PATTERNS, file)) continue;
    if (!isPathAllowed({ allowedPaths: task.spec.allowedPaths, blockedPaths: task.spec.blockedPaths }, file)) {
      violations.push(file);
    }
  }
  if (diffFiles.length === 0 && !(task.spec.allowNoChanges ?? false)) {
    violations.push('(no changes produced by worker)');
  }

  const headAfter = await currentHead(worktreePath);
  const ok = commands.every((c) => c.ok) && violations.length === 0 && headAfter === headBefore;

  let logPath: string | null = null;
  if (opts.logDir) {
    logPath = join(opts.logDir, `${task.taskId}-a${task.attempts}.log`);
    await mkdir(dirname(logPath), { recursive: true });
    const body = [
      ...commands.map((c) => `$ ${c.command}\nexit=${c.exitCode}\n${c.output}`),
      `diff files:\n${diffFiles.join('\n')}`,
      violations.length > 0 ? `violations:\n${violations.join('\n')}` : 'violations: none',
      `head ${headBefore} -> ${headAfter}`,
    ].join('\n\n');
    await writeFile(logPath, body, 'utf8');
  }

  return { ok, commands, violations, diffFiles, headBefore, headAfter, logPath };
}
