// tasks repository.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { SqliteDb } from './db.ts';
import { nowIso } from './ids.ts';
import type { TaskRecord, TaskSpec, TaskStatus } from '../core/types.ts';

interface TaskRow {
  run_id: string;
  task_id: string;
  spec_json: string;
  status: string;
  attempts: number;
  review_cycles: number;
  branch: string | null;
  worktree_path: string | null;
  workspace_id: string | null;
  start_sha: string | null;
  commit_sha: string | null;
  integration_commit: string | null;
  last_error: string | null;
  contract_block_json: string | null;
  review_json: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function toRecord(row: TaskRow): TaskRecord {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    spec: JSON.parse(row.spec_json) as TaskSpec,
    status: row.status as TaskStatus,
    attempts: row.attempts,
    reviewCycles: row.review_cycles,
    branch: row.branch,
    worktreePath: row.worktree_path,
    workspaceId: row.workspace_id,
    startSha: row.start_sha,
    commitSha: row.commit_sha,
    integrationCommit: row.integration_commit,
    lastError: row.last_error,
    contractBlock: row.contract_block_json ? JSON.parse(row.contract_block_json) : null,
    review: row.review_json ? JSON.parse(row.review_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export function insertTask(db: SqliteDb, runId: string, spec: TaskSpec, status: TaskStatus = 'pending'): void {
  const now = nowIso();
  db.run(
    `INSERT INTO tasks (run_id, task_id, spec_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [runId, spec.id, JSON.stringify(spec), status, now, now],
  );
}

export function getTask(db: SqliteDb, runId: string, taskId: string): TaskRecord | null {
  const row = db
    .query<TaskRow, [string, string]>('SELECT * FROM tasks WHERE run_id = ? AND task_id = ?')
    .get(runId, taskId);
  return row ? toRecord(row) : null;
}

export function listTasks(db: SqliteDb, runId: string): TaskRecord[] {
  return (db.query<TaskRow, [string]>('SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id').all(runId)).map(toRecord);
}

export function listTasksByStatus(db: SqliteDb, runId: string, statuses: readonly TaskStatus[]): TaskRecord[] {
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db
    .query<TaskRow, [string, ...TaskStatus[]]>(`SELECT * FROM tasks WHERE run_id = ? AND status IN (${placeholders}) ORDER BY task_id`)
    .all(runId, ...statuses);
  return rows.map(toRecord);
}

const TERMINAL_TASK = ['reclaimed'];

export interface TaskPatch {
  status?: TaskStatus;
  attempts?: number;
  reviewCycles?: number;
  branch?: string | null;
  worktreePath?: string | null;
  workspaceId?: string | null;
  startSha?: string | null;
  commitSha?: string | null;
  integrationCommit?: string | null;
  lastError?: string | null;
  contractBlock?: unknown | null;
  review?: unknown | null;
}

export function updateTask(db: SqliteDb, runId: string, taskId: string, patch: TaskPatch): void {
  const sets: string[] = [];
  const values: SQLQueryBindings[] = [];
  const push = (col: string, value: SQLQueryBindings): void => {
    sets.push(`${col} = ?`);
    values.push(value);
  };
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.attempts !== undefined) push('attempts', patch.attempts);
  if (patch.reviewCycles !== undefined) push('review_cycles', patch.reviewCycles);
  if (patch.branch !== undefined) push('branch', patch.branch);
  if (patch.worktreePath !== undefined) push('worktree_path', patch.worktreePath);
  if (patch.workspaceId !== undefined) push('workspace_id', patch.workspaceId);
  if (patch.startSha !== undefined) push('start_sha', patch.startSha);
  if (patch.commitSha !== undefined) push('commit_sha', patch.commitSha);
  if (patch.integrationCommit !== undefined) push('integration_commit', patch.integrationCommit);
  if (patch.lastError !== undefined) push('last_error', patch.lastError);
  if (patch.contractBlock !== undefined) {
    push('contract_block_json', patch.contractBlock === null ? null : JSON.stringify(patch.contractBlock));
  }
  if (patch.review !== undefined) {
    push('review_json', patch.review === null ? null : JSON.stringify(patch.review));
  }
  const terminal = patch.status !== undefined && TERMINAL_TASK.includes(patch.status);
  push('updated_at', nowIso());
  push('finished_at', terminal ? nowIso() : null);
  values.push(runId, taskId);
  db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE run_id = ? AND task_id = ?`, values);
}
