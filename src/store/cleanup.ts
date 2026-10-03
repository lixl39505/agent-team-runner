// cleanup_audit repository — one row per reclaim step, each retryable.

import type { SqliteDb } from './db.ts';
import { nowIso } from './ids.ts';
import type { CleanupStep } from '../core/types.ts';

export interface CleanupAuditRecord {
  id: number;
  runId: string;
  taskId: string;
  step: CleanupStep;
  branch: string | null;
  worktreePath: string | null;
  workspaceId: string | null;
  paneId: string | null;
  finalCommit: string | null;
  status: 'pending' | 'ok' | 'failed';
  detail: unknown | null;
  createdAt: string;
}

interface CleanupRow {
  id: number;
  run_id: string;
  task_id: string;
  step: string;
  branch: string | null;
  worktree_path: string | null;
  workspace_id: string | null;
  pane_id: string | null;
  final_commit: string | null;
  status: string;
  detail_json: string | null;
  created_at: string;
}

function toRecord(row: CleanupRow): CleanupAuditRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    step: row.step as CleanupStep,
    branch: row.branch,
    worktreePath: row.worktree_path,
    workspaceId: row.workspace_id,
    paneId: row.pane_id,
    finalCommit: row.final_commit,
    status: row.status as CleanupAuditRecord['status'],
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
    createdAt: row.created_at,
  };
}

export function recordCleanupStep(
  db: SqliteDb,
  input: {
    runId: string;
    taskId: string;
    step: CleanupStep;
    branch?: string | null;
    worktreePath?: string | null;
    workspaceId?: string | null;
    paneId?: string | null;
    finalCommit?: string | null;
    status: 'pending' | 'ok' | 'failed';
    detail?: unknown;
  },
): number {
  const res = db.run(
    `INSERT INTO cleanup_audit (run_id, task_id, step, branch, worktree_path, workspace_id, pane_id, final_commit, status, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.runId, input.taskId, input.step, input.branch ?? null, input.worktreePath ?? null,
      input.workspaceId ?? null, input.paneId ?? null, input.finalCommit ?? null, input.status,
      input.detail === undefined ? null : JSON.stringify(input.detail), nowIso()],
  );
  return Number(res.lastInsertRowid);
}

/** Latest audit row per step for a task (resume point calculation). */
export function latestCleanupSteps(db: SqliteDb, runId: string, taskId: string): Map<CleanupStep, CleanupAuditRecord> {
  const rows = db
    .query<CleanupRow, [string, string]>(
      'SELECT * FROM cleanup_audit WHERE run_id = ? AND task_id = ? ORDER BY id',
    )
    .all(runId, taskId);
  const latest = new Map<CleanupStep, CleanupAuditRecord>();
  for (const row of rows) latest.set(row.step as CleanupStep, toRecord(row));
  return latest;
}
