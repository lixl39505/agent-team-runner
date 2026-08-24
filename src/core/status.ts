import type { RunRecord, TaskRecord } from './types.js';

export function formatRunStatus(run: RunRecord, tasks: TaskRecord[]): string {
  const lines = [
    `RUN ${run.id}`,
    `Status: ${run.status}`,
    `Base: ${run.baseRef} (${run.baseSha.slice(0, 12)})`,
    `Lead backend: ${run.adapter}`,
    ''
  ];
  const width = Math.max(4, ...tasks.map((task) => task.taskId.length));
  for (const task of tasks) {
    const pid = task.pid ? ` pid=${task.pid}` : '';
    const commit = task.commitSha ? ` ${task.commitSha.slice(0, 10)}` : '';
    const attempts = ` attempt=${task.attempts}`;
    lines.push(`${task.taskId.padEnd(width)}  ${task.status.padEnd(18)} ${task.title}${attempts}${pid}${commit}`);
    if (task.lastError && ['failed', 'blocked', 'changes_requested'].includes(task.status)) {
      lines.push(`${' '.repeat(width + 2)}${task.lastError.split('\n')[0]}`);
    }
  }
  if (run.integrationBranch) lines.push('', `Integration branch: ${run.integrationBranch}`);
  if (run.integrationWorktree) lines.push(`Integration worktree: ${run.integrationWorktree}`);
  if (run.integrationCommit) lines.push(`Integration commit: ${run.integrationCommit}`);
  if (run.error) lines.push('', `Run error: ${run.error}`);
  return lines.join('\n');
}
