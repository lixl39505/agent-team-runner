// herdr_resources repository — the local projection of runtime resources.
// Every Herdr id here was captured from a Herdr response, never predicted.

import type { SqliteDb } from './db.ts';
import { nowIso } from './ids.ts';
import type { HerdrResourceKind, HerdrResourceRecord, HerdrResourceState } from '../core/types.ts';

interface ResourceRow {
  id: number;
  run_id: string;
  task_id: string | null;
  execution_id: string | null;
  kind: string;
  herdr_id: string;
  branch: string | null;
  path: string | null;
  provenance: number;
  state: string;
  created_at: string;
  reclaimed_at: string | null;
}

function toRecord(row: ResourceRow): HerdrResourceRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    kind: row.kind as HerdrResourceKind,
    herdrId: row.herdr_id,
    branch: row.branch,
    path: row.path,
    provenance: row.provenance === 1,
    state: row.state as HerdrResourceState,
    createdAt: row.created_at,
    reclaimedAt: row.reclaimed_at,
  };
}

export function insertResource(
  db: SqliteDb,
  input: {
    runId: string;
    taskId?: string | null;
    executionId?: string | null;
    kind: HerdrResourceKind;
    herdrId: string;
    branch?: string | null;
    path?: string | null;
  },
): HerdrResourceRecord {
  db.run(
    `INSERT INTO herdr_resources (run_id, task_id, execution_id, kind, herdr_id, branch, path, provenance, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?)
     ON CONFLICT (kind, herdr_id) DO NOTHING`,
    [input.runId, input.taskId ?? null, input.executionId ?? null, input.kind, input.herdrId,
      input.branch ?? null, input.path ?? null, nowIso()],
  );
  const row = db
    .query<ResourceRow, [string, string]>('SELECT * FROM herdr_resources WHERE kind = ? AND herdr_id = ?')
    .get(input.kind, input.herdrId)!;
  return toRecord(row);
}

export function listActiveResources(db: SqliteDb, runId: string): HerdrResourceRecord[] {
  return (
    db.query<ResourceRow, [string]>(
      "SELECT * FROM herdr_resources WHERE run_id = ? AND state = 'active' ORDER BY id",
    ).all(runId)
  ).map(toRecord);
}

export function getResource(db: SqliteDb, kind: HerdrResourceKind, herdrId: string): HerdrResourceRecord | null {
  const row = db
    .query<ResourceRow, [string, string]>('SELECT * FROM herdr_resources WHERE kind = ? AND herdr_id = ?')
    .get(kind, herdrId);
  return row ? toRecord(row) : null;
}

export function markResourceState(db: SqliteDb, kind: HerdrResourceKind, herdrId: string, state: HerdrResourceState): void {
  db.run('UPDATE herdr_resources SET state = ?, reclaimed_at = ? WHERE kind = ? AND herdr_id = ?', [
    state, state === 'active' ? null : nowIso(), kind, herdrId,
  ]);
}
