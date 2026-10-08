// Runner single-writer lease. Only a lease holder may schedule tasks or
// write delivery conclusions; reconcile/clean take over only when the
// lease is stale.
//
// Review 02 R2-06: the previous "SELECT then unconditional UPSERT" let two
// processes observe the same empty/stale lease and both succeed. Acquisition
// now runs inside BEGIN IMMEDIATE (serialized against other processes) and
// every holder carries a random fencing token: heartbeat and release are
// token-CAS updates whose rowcount the caller MUST check, so a taken-over
// runner detects loss instead of silently writing alongside the new holder.

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { SqliteDb } from './db.ts';
import { inTransaction } from './db.ts';
import { nowIso } from './ids.ts';

const STALE_MS = 30_000;

export function leaseHolder(): string {
  return `${process.pid}@${hostname()}`;
}

function isStale(heartbeatAt: string, now: number): boolean {
  return now - Date.parse(heartbeatAt) > STALE_MS;
}

interface LeaseRow {
  holder: string;
  heartbeat_at: string;
  state: string;
  fence: string | null;
}

/** Try to acquire the lease. Returns the fencing token, or null when a live
 * lease exists. R3-06: a LIVE lease refuses takeover regardless of the
 * holder string — the previous same-holder exemption let a second engine in
 * the SAME process mint its own fence and write alongside the first. An
 * existing holder renews through heartbeat(); only a STALE lease (or a
 * released/absent row) may be acquired. */
export function acquireLease(db: SqliteDb, runId: string): string | null {
  const holder = leaseHolder();
  // BEGIN IMMEDIATE serializes the read-decide-write against every other
  // process — the takeover decision can no longer race (R2-06)
  return inTransaction(db, () => {
    const now = Date.now();
    const row = db.query<LeaseRow, [string]>(
      'SELECT holder, heartbeat_at, state, fence FROM runner_leases WHERE run_id = ?',
    ).get(runId);
    if (row && row.state === 'alive' && !isStale(row.heartbeat_at, now)) {
      return null;
    }
    const fence = randomBytes(16).toString('hex');
    db.run(
      `INSERT INTO runner_leases (run_id, holder, heartbeat_at, state, fence) VALUES (?, ?, ?, 'alive', ?)
       ON CONFLICT (run_id) DO UPDATE SET holder = excluded.holder, heartbeat_at = excluded.heartbeat_at, state = 'alive', fence = excluded.fence`,
      [runId, holder, nowIso(), fence],
    );
    return fence;
  });
}

/**
 * Renew the lease. Returns false when the caller no longer holds it —
 * (run, holder, fence) matched no alive row, i.e. another process took over
 * or the lease was released. Callers must stop writing delivery state on
 * false; a lost heartbeat that still "succeeds" is what let the old lease
 * be shared (R2-06).
 */
export function heartbeat(db: SqliteDb, runId: string, fence: string | null): boolean {
  if (!fence) return false;
  const res = db.run(
    `UPDATE runner_leases SET heartbeat_at = ?, state = 'alive' WHERE run_id = ? AND holder = ? AND fence = ? AND state = 'alive'`,
    [nowIso(), runId, leaseHolder(), fence],
  );
  return res.changes > 0;
}

/** Release only if still holding the token; a taken-over lease stays intact. */
export function releaseLease(db: SqliteDb, runId: string, fence: string | null): void {
  if (!fence) return;
  db.run(
    "UPDATE runner_leases SET state = 'released' WHERE run_id = ? AND holder = ? AND fence = ?",
    [runId, leaseHolder(), fence],
  );
}

/** Read-side check: does (holder, fence) currently own a live lease? */
export function assertLease(db: SqliteDb, runId: string, fence: string | null): boolean {
  if (!fence) return false;
  const row = db.query<LeaseRow, [string]>(
    'SELECT holder, heartbeat_at, state, fence FROM runner_leases WHERE run_id = ?',
  ).get(runId);
  return !!row
    && row.state === 'alive'
    && row.holder === leaseHolder()
    && row.fence === fence
    && !isStale(row.heartbeat_at, Date.now());
}

export function leaseIsAlive(db: SqliteDb, runId: string): boolean {
  const row = db.query<LeaseRow, [string]>(
    'SELECT holder, heartbeat_at, state FROM runner_leases WHERE run_id = ?',
  ).get(runId);
  if (!row || row.state !== 'alive') return false;
  return row.holder === leaseHolder() || !isStale(row.heartbeat_at, Date.now());
}
