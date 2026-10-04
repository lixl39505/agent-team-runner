// runs + contract_revisions repositories.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { SqliteDb } from './db.ts';
import { inTransaction } from './db.ts';
import { nowIso } from './ids.ts';
import type { ExecutionContract, RunRecord, RunStatus } from '../core/types.ts';

interface RunRow {
  id: string;
  project_id: string;
  repo_root: string;
  base_ref: string;
  base_sha: string;
  contract_revision: number;
  status: string;
  revision_pending: number;
  error: string | null;
  integration_workspace_id: string | null;
  integration_path: string | null;
  integration_branch: string | null;
  integration_root_pane_id: string | null;
  integration_base_sha: string | null;
  conflict_task_id: string | null;
  integration_stalled: number;
  final_verified: number;
  final_verified_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function toRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    repoRoot: row.repo_root,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    contractRevision: row.contract_revision,
    status: row.status as RunStatus,
    revisionPending: row.revision_pending === 1,
    error: row.error,
    integrationWorkspaceId: row.integration_workspace_id,
    integrationPath: row.integration_path,
    integrationBranch: row.integration_branch,
    integrationRootPaneId: row.integration_root_pane_id,
    integrationBaseSha: row.integration_base_sha,
    conflictTaskId: row.conflict_task_id,
    integrationStalled: row.integration_stalled === 1,
    finalVerified: row.final_verified === 1,
    finalVerifiedAt: row.final_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export function insertRun(
  db: SqliteDb,
  input: { id: string; contract: ExecutionContract; baseSha: string; status: RunStatus },
): RunRecord {
  const now = nowIso();
  db.run(
    `INSERT INTO runs (id, project_id, repo_root, base_ref, base_sha, contract_revision, status,
                       revision_pending, error, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 0, NULL, ?, ?, NULL)`,
    [input.id, input.contract.project.id, input.contract.project.repoRoot,
      input.contract.project.baseRef, input.baseSha, input.status, now, now],
  );
  db.run(
    `INSERT INTO contract_revisions (run_id, revision, contract_json, created_at)
     VALUES (?, 1, ?, ?)`,
    [input.id, JSON.stringify(input.contract), now],
  );
  return getRun(db, input.id)!;
}

export function getRun(db: SqliteDb, runId: string): RunRecord | null {
  const row = db.query<RunRow, [string]>('SELECT * FROM runs WHERE id = ?').get(runId);
  return row ? toRecord(row) : null;
}

export function listRuns(db: SqliteDb, opts: { nonTerminalOnly?: boolean } = {}): RunRecord[] {
  const sql = opts.nonTerminalOnly
    ? `SELECT * FROM runs WHERE status IN ('queued','planning','planned','running','needs_attention','integrating')
       ORDER BY created_at`
    : 'SELECT * FROM runs ORDER BY created_at';
  return (db.query<RunRow, []>(sql).all()).map(toRecord);
}

export function updateRunStatus(db: SqliteDb, runId: string, status: RunStatus, error?: string): void {
  const terminal = ['done', 'cancelled', 'abandoned', 'failed'].includes(status);
  db.run(
    `UPDATE runs SET status = ?, error = ?, updated_at = ?, finished_at = ?
     WHERE id = ?`,
    [status, error ?? null, nowIso(), terminal ? nowIso() : null, runId],
  );
}

/** Latest contract revision (defaults to 1). */
export function getContractRevision(db: SqliteDb, runId: string): ExecutionContract | null {
  const row = db
    .query<{ contract_json: string }, [string]>(
      'SELECT contract_json FROM contract_revisions WHERE run_id = ? ORDER BY revision DESC LIMIT 1',
    )
    .get(runId);
  return row ? (JSON.parse(row.contract_json) as ExecutionContract) : null;
}

export function getContractRevisionAt(db: SqliteDb, runId: string, revision: number): ExecutionContract | null {
  const row = db
    .query<{ contract_json: string }, [string, number]>(
      'SELECT contract_json FROM contract_revisions WHERE run_id = ? AND revision = ?',
    )
    .get(runId, revision);
  return row ? (JSON.parse(row.contract_json) as ExecutionContract) : null;
}

/** Append an immutable revision and flag it pending for Runner consumption. */
export function appendContractRevision(db: SqliteDb, runId: string, contract: ExecutionContract): number {
  return inTransaction(db, () => {
    const run = getRun(db, runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    const next = run.contractRevision + 1;
    db.run(
      'INSERT INTO contract_revisions (run_id, revision, contract_json, created_at) VALUES (?, ?, ?, ?)',
      [runId, next, JSON.stringify(contract), nowIso()],
    );
    db.run(
      'UPDATE runs SET contract_revision = ?, revision_pending = 1, updated_at = ? WHERE id = ?',
      [next, nowIso(), runId],
    );
    return next;
  });
}

export function clearRevisionPending(db: SqliteDb, runId: string): void {
  db.run('UPDATE runs SET revision_pending = 0, updated_at = ? WHERE id = ?', [nowIso(), runId]);
}

/** Persisted Runner state-machine fields (review 01 #3): integration
 * resources, conflict phase and final-verification conclusion survive a
 * Runner restart and are the only source `reconcile` trusts. */
export interface RunRuntimeStatePatch {
  integrationWorkspaceId?: string | null;
  integrationPath?: string | null;
  integrationBranch?: string | null;
  integrationRootPaneId?: string | null;
  integrationBaseSha?: string | null;
  conflictTaskId?: string | null;
  integrationStalled?: boolean;
  finalVerified?: boolean;
  finalVerifiedAt?: string | null;
}

export function updateRunRuntimeState(db: SqliteDb, runId: string, patch: RunRuntimeStatePatch): void {
  const sets: string[] = [];
  const values: SQLQueryBindings[] = [];
  const push = (col: string, value: SQLQueryBindings): void => {
    sets.push(`${col} = ?`);
    values.push(value);
  };
  if (patch.integrationWorkspaceId !== undefined) push('integration_workspace_id', patch.integrationWorkspaceId);
  if (patch.integrationPath !== undefined) push('integration_path', patch.integrationPath);
  if (patch.integrationBranch !== undefined) push('integration_branch', patch.integrationBranch);
  if (patch.integrationRootPaneId !== undefined) push('integration_root_pane_id', patch.integrationRootPaneId);
  if (patch.integrationBaseSha !== undefined) push('integration_base_sha', patch.integrationBaseSha);
  if (patch.conflictTaskId !== undefined) push('conflict_task_id', patch.conflictTaskId);
  if (patch.integrationStalled !== undefined) push('integration_stalled', patch.integrationStalled ? 1 : 0);
  if (patch.finalVerified !== undefined) push('final_verified', patch.finalVerified ? 1 : 0);
  if (patch.finalVerifiedAt !== undefined) push('final_verified_at', patch.finalVerifiedAt);
  push('updated_at', nowIso());
  values.push(runId);
  db.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, values);
}
