// verifications repository (review 02 R2-14): mechanical gate outcomes are
// persisted as queryable records — which verification, against which
// contract revision and commit, with which commands and logs — instead of
// living only in event payloads. The persisted passing record is what
// cleanup eligibility keys off (src/runner/cleanup.ts), not just a
// run-level boolean.

import type { SqliteDb } from './db.ts';
import { nowIso } from './ids.ts';

/** 'task' = per-task mechanical gate; 'final' = integration final gate. */
export type VerificationKind = 'task' | 'final';

interface VerificationRow {
  id: number;
  run_id: string;
  task_id: string | null;
  kind: string;
  attempt_no: number | null;
  ok: number;
  detail_json: string | null;
  log_path: string | null;
  created_at: string;
}

export interface VerificationDetail {
  /** Contract revision the verified tree was built from. */
  contractRevision?: number;
  /** HEAD the gate ran against. */
  headSha?: string | null;
  /** Base the diff/change set was measured from. */
  baseSha?: string | null;
  violations?: string[];
  diffFiles?: string[];
  commands?: Array<{ command: string; ok: boolean; exitCode: number }>;
  [key: string]: unknown;
}

export interface VerificationRecord {
  id: number;
  runId: string;
  taskId: string | null;
  kind: VerificationKind;
  attemptNo: number | null;
  ok: boolean;
  detail: VerificationDetail | null;
  logPath: string | null;
  createdAt: string;
}

function toRecord(row: VerificationRow): VerificationRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    kind: row.kind as VerificationKind,
    attemptNo: row.attempt_no,
    ok: row.ok === 1,
    detail: row.detail_json ? (JSON.parse(row.detail_json) as VerificationDetail) : null,
    logPath: row.log_path,
    createdAt: row.created_at,
  };
}

export function insertVerification(
  db: SqliteDb,
  input: {
    runId: string;
    taskId?: string | null;
    kind: VerificationKind;
    attemptNo?: number | null;
    ok: boolean;
    detail?: VerificationDetail;
    logPath?: string | null;
  },
): void {
  db.run(
    `INSERT INTO verifications (run_id, task_id, kind, attempt_no, ok, detail_json, log_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.runId, input.taskId ?? null, input.kind, input.attemptNo ?? null, input.ok ? 1 : 0,
      input.detail ? JSON.stringify(input.detail) : null, input.logPath ?? null, nowIso()],
  );
}

export function listVerifications(db: SqliteDb, runId: string): VerificationRecord[] {
  return (
    db.query<VerificationRow, [string]>('SELECT * FROM verifications WHERE run_id = ? ORDER BY id').all(runId)
  ).map(toRecord);
}

/** The latest persisted verification record of one kind for a run. */
export function latestVerification(db: SqliteDb, runId: string, kind: VerificationKind): VerificationRecord | null {
  const row = db
    .query<VerificationRow, [string, string]>(
      'SELECT * FROM verifications WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1',
    )
    .get(runId, kind);
  return row ? toRecord(row) : null;
}

/**
 * Cleanup eligibility (R2-03/R2-14): a PASSING final verification record
 * must exist. The runs.final_verified flag alone is not proof — the record
 * carries the revision, integration HEAD, commands and log that justify
 * reclamation.
 */
export function hasPassingFinalVerification(db: SqliteDb, runId: string): boolean {
  return latestVerification(db, runId, 'final')?.ok === true;
}
