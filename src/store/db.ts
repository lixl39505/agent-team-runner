// bun:sqlite delivery ledger: STRICT tables, WAL, and transaction helpers.
// The ledger is the authority for delivery state; Herdr remains the
// authority for runtime resources (ADR 0001).

import { Database } from 'bun:sqlite';

export type SqliteDb = Database;

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    repo_root TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    contract_revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    revision_pending INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  ) STRICT;

  CREATE TABLE contract_revisions (
    run_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    contract_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, revision)
  ) STRICT;

  CREATE TABLE tasks (
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    review_cycles INTEGER NOT NULL DEFAULT 0,
    branch TEXT,
    worktree_path TEXT,
    workspace_id TEXT,
    start_sha TEXT,
    commit_sha TEXT,
    integration_commit TEXT,
    last_error TEXT,
    contract_block_json TEXT,
    review_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    PRIMARY KEY (run_id, task_id)
  ) STRICT;

  CREATE TABLE executions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    cycle_no INTEGER NOT NULL DEFAULT 0,
    agent_name TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    prompt_sent_at TEXT,
    prompt_digest TEXT,
    result_path TEXT,
    result_digest TEXT,
    result_json TEXT,
    result_received_at TEXT,
    native_session_ref TEXT,
    pane_id TEXT,
    tab_id TEXT,
    workspace_id TEXT,
    pane_state TEXT NOT NULL DEFAULT 'open',
    last_agent_state TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (run_id, task_id, role, attempt_no, cycle_no)
  ) STRICT;

  CREATE TABLE herdr_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_id TEXT,
    execution_id TEXT,
    kind TEXT NOT NULL,
    herdr_id TEXT NOT NULL,
    branch TEXT,
    path TEXT,
    provenance INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    reclaimed_at TEXT,
    UNIQUE (kind, herdr_id)
  ) STRICT;

  CREATE TABLE verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_id TEXT,
    kind TEXT NOT NULL,
    attempt_no INTEGER,
    ok INTEGER NOT NULL,
    detail_json TEXT,
    log_path TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE cleanup_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    step TEXT NOT NULL,
    branch TEXT,
    worktree_path TEXT,
    workspace_id TEXT,
    pane_id TEXT,
    final_commit TEXT,
    status TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_id TEXT,
    execution_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE runner_leases (
    run_id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    state TEXT NOT NULL
  ) STRICT;

  CREATE INDEX idx_tasks_status ON tasks(run_id, status);
  CREATE INDEX idx_exec_run_status ON executions(run_id, status);
  CREATE INDEX idx_res_run ON herdr_resources(run_id, kind, state);
  CREATE INDEX idx_events_run ON events(run_id, id);
  `,
];

export function openDatabase(path: string): SqliteDb {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: SqliteDb): void {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    inTransaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    version += 1;
  }
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT; rollback on throw. */
export function inTransaction<T>(db: SqliteDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* connection already rolled back */
    }
    throw err;
  }
}

/** Nested transaction support via savepoints. */
export function inSavepoint<T>(db: SqliteDb, name: string, fn: () => T): T {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, '_');
  db.exec(`SAVEPOINT ${safe}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${safe}`);
    return out;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${safe}`);
      db.exec(`RELEASE ${safe}`);
    } catch {
      /* already released */
    }
    throw err;
  }
}
