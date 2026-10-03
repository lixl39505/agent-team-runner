// agent-team status / log / results / attach — read-only inspection.

import type { SqliteDb } from '../store/db.ts';
import { getRun, listRuns } from '../store/runs.ts';
import { listTasks, getTask } from '../store/tasks.ts';
import { listExecutions } from '../store/executions.ts';
import { listEvents } from '../store/events.ts';
import { listActiveResources } from '../store/resources.ts';
import { latestCleanupSteps } from '../store/cleanup.ts';
import { AteamError } from '../core/errors.ts';

export interface StatusSnapshot {
  run: ReturnType<typeof getRun>;
  tasks: ReturnType<typeof listTasks>;
  executions: ReturnType<typeof listExecutions>;
  resources: ReturnType<typeof listActiveResources>;
}

export function snapshot(db: SqliteDb, runId: string): StatusSnapshot {
  const run = getRun(db, runId);
  if (!run) throw new AteamError(`run not found: ${runId}`);
  return {
    run,
    tasks: listTasks(db, runId),
    executions: listExecutions(db, runId),
    resources: listActiveResources(db, runId),
  };
}

export function renderStatus(snap: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`run ${snap.run!.id}  [${snap.run!.status}]  project=${snap.run!.projectId}  base=${snap.run!.baseRef}@${snap.run!.baseSha.slice(0, 8)}`);
  if (snap.run!.error) lines.push(`  error: ${snap.run!.error}`);
  for (const task of snap.tasks) {
    const bits = [`task ${task.taskId} [${task.status}]`, `attempts=${task.attempts}`, `cycles=${task.reviewCycles}`];
    if (task.commitSha) bits.push(`commit=${task.commitSha.slice(0, 8)}`);
    if (task.integrationCommit) bits.push(`integrated=${task.integrationCommit.slice(0, 8)}`);
    if (task.worktreePath) bits.push(`wt=${task.worktreePath}`);
    lines.push('  ' + bits.join('  '));
  }
  for (const exec of snap.executions) {
    lines.push(
      `  exec ${exec.id} [${exec.status}] ${exec.role} a${exec.attemptNo}c${exec.cycleNo} agent=${exec.agentName}(${exec.agentKind})` +
        ` pane=${exec.paneId ?? '-'} state=${exec.paneState} prompt=${exec.promptSentAt ? 'yes' : 'NO'}` +
        (exec.lastAgentState ? ` observed=${exec.lastAgentState}` : ''),
    );
  }
  return lines.join('\n');
}

export function renderLog(db: SqliteDb, runId: string, opts: { taskId?: string; limit?: number }): string {
  const events = listEvents(db, runId, { taskId: opts.taskId, limit: opts.limit });
  return events
    .map((e) => `${e.createdAt} ${e.eventType}${e.taskId ? ` ${e.taskId}` : ''}${e.payload ? ' ' + JSON.stringify(e.payload) : ''}`)
    .join('\n');
}

/** Where a human can attach; only retained/blocked panes qualify. */
export function attachTargets(db: SqliteDb, runId: string): Array<{ taskId: string; paneId: string; reason: string }> {
  const snap = snapshot(db, runId);
  const out: Array<{ taskId: string; paneId: string; reason: string }> = [];
  for (const exec of snap.executions) {
    if (exec.paneId && ['retained', 'open', 'gone'].includes(exec.paneState) === false) continue;
    if (!exec.paneId) continue;
    if (['completed'].includes(exec.status) && exec.paneState === 'closed_success') continue;
    out.push({ taskId: exec.taskId, paneId: exec.paneId, reason: exec.status });
  }
  return out;
}

export function renderCleanupState(db: SqliteDb, runId: string): string {
  const lines: string[] = [];
  for (const task of listTasks(db, runId)) {
    const steps = latestCleanupSteps(db, runId, task.taskId);
    if (steps.size === 0) continue;
    const summary = [...steps.entries()].map(([step, rec]) => `${step}=${rec.status}`).join(' ');
    lines.push(`task ${task.taskId}: ${summary}`);
  }
  return lines.join('\n');
}

export { getTask };
