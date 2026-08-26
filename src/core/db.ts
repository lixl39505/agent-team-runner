import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  RunRecord,
  RunStatus,
  TaskRecord,
  TaskSpec,
  TaskStatus
} from './types.js';

function now(): string {
  return new Date().toISOString();
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    repoRoot: String(row.repo_root),
    goalFile: String(row.goal_file),
    baseRef: String(row.base_ref),
    baseSha: String(row.base_sha),
    adapter: String(row.adapter),
    status: String(row.status) as RunStatus,
    manifestJson: row.manifest_json === null ? null : String(row.manifest_json),
    rolesJson: row.roles_json === null || row.roles_json === undefined ? null : String(row.roles_json),
    integrationBranch: row.integration_branch === null ? null : String(row.integration_branch),
    integrationWorktree: row.integration_worktree === null ? null : String(row.integration_worktree),
    integrationCommit: row.integration_commit === null ? null : String(row.integration_commit),
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at)
  };
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    runId: String(row.run_id),
    taskId: String(row.task_id),
    title: String(row.title),
    specJson: String(row.spec_json),
    status: String(row.status) as TaskStatus,
    phase: row.phase === null ? null : String(row.phase),
    branch: row.branch === null ? null : String(row.branch),
    worktree: row.worktree === null ? null : String(row.worktree),
    startSha: row.start_sha === null ? null : String(row.start_sha),
    commitSha: row.commit_sha === null ? null : String(row.commit_sha),
    attempts: Number(row.attempts),
    reviewCycles: Number(row.review_cycles),
    lastError: row.last_error === null ? null : String(row.last_error),
    reviewJson: row.review_json === null ? null : String(row.review_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at)
  };
}

export class StateDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        goal_file TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        adapter TEXT NOT NULL,
        status TEXT NOT NULL,
        manifest_json TEXT,
        roles_json TEXT,
        integration_branch TEXT,
        integration_worktree TEXT,
        integration_commit TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tasks (
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT,
        branch TEXT,
        worktree TEXT,
        start_sha TEXT,
        commit_sha TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        review_cycles INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        review_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (run_id, task_id),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        task_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
    `);
    this.addColumnIfMissing('runs', 'roles_json', 'TEXT');
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
    }
  }

  createRun(input: {
    id: string;
    repoRoot: string;
    goalFile: string;
    baseRef: string;
    baseSha: string;
    adapter: string;
  }): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO runs (
        id, repo_root, goal_file, base_ref, base_sha, adapter, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'planning', ?, ?)
    `).run(
      input.id,
      input.repoRoot,
      input.goalFile,
      input.baseRef,
      input.baseSha,
      input.adapter,
      timestamp,
      timestamp
    );
    this.addEvent(input.id, null, 'RUN_CREATED', input);
  }

  getRun(id: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Run not found: ${id}`);
    return mapRun(row);
  }

  listRuns(): RunRecord[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(mapRun);
  }

  updateRun(id: string, patch: Partial<{
    status: RunStatus;
    manifestJson: string;
    rolesJson: string;
    integrationBranch: string;
    integrationWorktree: string;
    integrationCommit: string;
    error: string | null;
    finishedAt: string | null;
  }>): void {
    const entries = Object.entries(patch);
    if (entries.length === 0) return;
    const columnMap: Record<string, string> = {
      status: 'status',
      manifestJson: 'manifest_json',
      rolesJson: 'roles_json',
      integrationBranch: 'integration_branch',
      integrationWorktree: 'integration_worktree',
      integrationCommit: 'integration_commit',
      error: 'error',
      finishedAt: 'finished_at'
    };
    const sets = entries.map(([key]) => `${columnMap[key]} = ?`);
    const values = entries.map(([, value]) => value);
    sets.push('updated_at = ?');
    values.push(now(), id);
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  insertTask(runId: string, spec: TaskSpec): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO tasks (
        run_id, task_id, title, spec_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(runId, spec.id, spec.title, JSON.stringify(spec), timestamp, timestamp);
    this.addEvent(runId, spec.id, 'TASK_CREATED', spec);
  }

  getTask(runId: string, taskId: string): TaskRecord {
    const row = this.db.prepare('SELECT * FROM tasks WHERE run_id = ? AND task_id = ?').get(runId, taskId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Task not found: ${runId}/${taskId}`);
    return mapTask(row);
  }

  listTasks(runId: string): TaskRecord[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id').all(runId) as Record<string, unknown>[]).map(mapTask);
  }

  updateTask(runId: string, taskId: string, patch: Partial<{
    status: TaskStatus;
    phase: string | null;
    branch: string;
    worktree: string;
    startSha: string;
    commitSha: string;
    attempts: number;
    reviewCycles: number;
    lastError: string | null;
    reviewJson: string | null;
    finishedAt: string | null;
  }>): void {
    const entries = Object.entries(patch);
    if (entries.length === 0) return;
    const columnMap: Record<string, string> = {
      status: 'status',
      phase: 'phase',
      branch: 'branch',
      worktree: 'worktree',
      startSha: 'start_sha',
      commitSha: 'commit_sha',
      attempts: 'attempts',
      reviewCycles: 'review_cycles',
      lastError: 'last_error',
      reviewJson: 'review_json',
      finishedAt: 'finished_at'
    };
    const sets = entries.map(([key]) => `${columnMap[key]} = ?`);
    const values = entries.map(([, value]) => value);
    sets.push('updated_at = ?');
    values.push(now(), runId, taskId);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE run_id = ? AND task_id = ?`).run(...values);
  }

  addEvent(runId: string, taskId: string | null, eventType: string, payload?: unknown): void {
    this.db.prepare(`
      INSERT INTO events (run_id, task_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, taskId, eventType, payload === undefined ? null : JSON.stringify(payload), now());
  }

  resetInterrupted(runId: string): void {
    const interrupted = this.db.prepare(`
      SELECT task_id FROM tasks
      WHERE run_id = ? AND status IN ('running', 'verifying', 'reviewing')
    `).all(runId) as Array<{ task_id: string }>;

    for (const row of interrupted) {
      this.updateTask(runId, row.task_id, {
        status: 'changes_requested',
        phase: 'recovered',
        lastError: 'Runner restarted while the task was active. Resume from the existing worktree.'
      });
      this.addEvent(runId, row.task_id, 'TASK_RECOVERED');
    }
  }
}
