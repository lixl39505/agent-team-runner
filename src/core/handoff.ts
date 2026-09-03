import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { StateDatabase } from './db.js';
import { writeJson, writeTextAtomic } from './files.js';

export function readHandoff(runsDir: string, runId: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(join(runsDir, runId, 'handoff.json'), 'utf8')) as unknown;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * 写 run 交接产物（handoff.json + handoff.md），两个文件都原子落盘。
 * 默认只在 run 已 done 时写入（重放修复路径）；`pendingDone` 供集成阶段在
 * 标记 done 之前调用——handoff 完整落盘先于 done 状态，崩溃不会留下
 * 「done 却没有 handoff」的不可判定状态。
 */
export function writeHandoff(
  db: StateDatabase,
  runsDir: string,
  runId: string,
  options: { pendingDone?: boolean } = {}
): void {
  const run = db.getRun(runId);
  if (run.status !== 'done' && options.pendingDone !== true) return;
  const tasks = db.listTasks(runId);
  const handoff = {
    version: 1,
    run: {
      id: run.id,
      projectId: run.projectId,
      projectPolicyRevisionId: run.projectPolicyRevisionId,
      contractRevision: run.contractRevision,
      status: 'done',
      baseRef: run.baseRef,
      baseSha: run.baseSha,
      integrationBranch: run.integrationBranch,
      integrationCommit: run.integrationCommit
    },
    tasks: tasks.map((task) => ({
      id: task.taskId,
      title: task.title,
      status: task.status,
      commitSha: task.commitSha,
      attempts: task.attempts,
      review: task.reviewJson === null ? null : JSON.parse(task.reviewJson),
      lastError: task.lastError
    })),
    contract: run.executionContractJson === null ? null : JSON.parse(run.executionContractJson)
  };
  const runDir = join(runsDir, runId);
  writeJson(join(runDir, 'handoff.json'), handoff);
  const lines = [
    `# Run Handoff: ${runId}`,
    '',
    '- Status: done',
    `- Integration branch: ${run.integrationBranch ?? 'none'}`,
    `- Integration commit: ${run.integrationCommit ?? 'none'}`,
    `- Contract revision: ${run.contractRevision}`,
    '',
    '## Tasks',
    ...tasks.map((task) => `- ${task.taskId}: ${task.status}${task.commitSha ? ` (${task.commitSha})` : ''}`)
  ];
  writeTextAtomic(join(runDir, 'handoff.md'), `${lines.join('\n')}\n`);
  db.addEvent(runId, null, 'RUN_HANDOFF_CREATED', { path: join(runDir, 'handoff.json') });
}
