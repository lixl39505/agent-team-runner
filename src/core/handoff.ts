import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { StateDatabase } from './db.js';
import { writeJson } from './files.js';

export function readHandoff(runsDir: string, runId: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(join(runsDir, runId, 'handoff.json'), 'utf8')) as unknown;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeHandoff(db: StateDatabase, runsDir: string, runId: string): void {
  const run = db.getRun(runId);
  if (run.status !== 'done') return;
  const tasks = db.listTasks(runId);
  const handoff = {
    version: 1,
    run: {
      id: run.id,
      projectId: run.projectId,
      projectPolicyRevisionId: run.projectPolicyRevisionId,
      contractRevision: run.contractRevision,
      status: run.status,
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
    `- Status: ${run.status}`,
    `- Integration branch: ${run.integrationBranch ?? 'none'}`,
    `- Integration commit: ${run.integrationCommit ?? 'none'}`,
    `- Contract revision: ${run.contractRevision}`,
    '',
    '## Tasks',
    ...tasks.map((task) => `- ${task.taskId}: ${task.status}${task.commitSha ? ` (${task.commitSha})` : ''}`)
  ];
  writeFileSync(join(runDir, 'handoff.md'), `${lines.join('\n')}\n`, 'utf8');
  db.addEvent(runId, null, 'RUN_HANDOFF_CREATED', { path: join(runDir, 'handoff.json') });
}
