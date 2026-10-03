// Append-only audit event stream. Events are for audit/status rendering
// only — recovery never replays them to drive state (ADR 0001).

import type { SqliteDb } from './db.ts';
import { nowIso } from './ids.ts';
import type { EventType } from '../core/types.ts';

export interface EventRecord {
  id: number;
  runId: string;
  taskId: string | null;
  executionId: string | null;
  eventType: EventType;
  payload: unknown | null;
  createdAt: string;
}

interface EventRow {
  id: number;
  run_id: string;
  task_id: string | null;
  execution_id: string | null;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    eventType: row.event_type as EventType,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    createdAt: row.created_at,
  };
}

export function addEvent(
  db: SqliteDb,
  runId: string,
  eventType: EventType,
  opts: { taskId?: string; executionId?: string; payload?: unknown } = {},
): number {
  const res = db.run(
    'INSERT INTO events (run_id, task_id, execution_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [runId, opts.taskId ?? null, opts.executionId ?? null, eventType,
      opts.payload === undefined ? null : JSON.stringify(opts.payload), nowIso()],
  );
  return Number(res.lastInsertRowid);
}

export function listEvents(
  db: SqliteDb,
  runId: string,
  opts: { taskId?: string; limit?: number } = {},
): EventRecord[] {
  const rows = opts.taskId
    ? db.query<EventRow, [string, string, number]>(
        'SELECT * FROM events WHERE run_id = ? AND task_id = ? ORDER BY id DESC LIMIT ?',
      ).all(runId, opts.taskId, opts.limit ?? 500)
    : db.query<EventRow, [string, number]>(
        'SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?',
      ).all(runId, opts.limit ?? 500);
  return rows.map(toRecord).reverse();
}
