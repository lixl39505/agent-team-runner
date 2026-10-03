// Runner single-writer lease. Only a lease holder may schedule tasks or
// write delivery conclusions; reconcile/clean take over only when the
// lease is stale.

import { hostname } from 'node:os';
import type { SqliteDb } from './db.ts';
import { nowIso } from './ids.ts';

const STALE_MS = 30_000;

export function leaseHolder(): string {
  return `${process.pid}@${hostname()}`;
}

function isStale(heartbeatAt: string, now: number): boolean {
  return now - Date.parse(heartbeatAt) > STALE_MS;
}

/** Try to acquire or refresh the lease. Returns false if a live runner holds it. */
export function acquireLease(db: SqliteDb, runId: string): boolean {
  const now = Date.now();
  const holder = leaseHolder();
  const row = db.query<{ holder: string; heartbeat_at: string; state: string }, [string]>(
    'SELECT holder, heartbeat_at, state FROM runner_leases WHERE run_id = ?',
  ).get(runId);
  if (!row || row.state !== 'alive' || isStale(row.heartbeat_at, now) || row.holder === holder) {
    db.run(
      `INSERT INTO runner_leases (run_id, holder, heartbeat_at, state) VALUES (?, ?, ?, 'alive')
       ON CONFLICT (run_id) DO UPDATE SET holder = excluded.holder, heartbeat_at = excluded.heartbeat_at, state = 'alive'`,
      [runId, holder, nowIso()],
    );
    return true;
  }
  return false;
}

export function heartbeat(db: SqliteDb, runId: string): void {
  db.run('UPDATE runner_leases SET heartbeat_at = ?, state = ? WHERE run_id = ? AND holder = ?', [
    nowIso(), 'alive', runId, leaseHolder(),
  ]);
}

export function releaseLease(db: SqliteDb, runId: string): void {
  db.run("UPDATE runner_leases SET state = 'released' WHERE run_id = ? AND holder = ?", [runId, leaseHolder()]);
}

export function leaseIsAlive(db: SqliteDb, runId: string): boolean {
  const row = db.query<{ holder: string; heartbeat_at: string; state: string }, [string]>(
    'SELECT holder, heartbeat_at, state FROM runner_leases WHERE run_id = ?',
  ).get(runId);
  if (!row || row.state !== 'alive') return false;
  return row.holder === leaseHolder() || !isStale(row.heartbeat_at, Date.now());
}
