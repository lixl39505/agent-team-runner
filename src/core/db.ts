import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentExecutionRecord,
  RunEventRecord,
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
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    projectPolicyRevisionId: row.project_policy_revision_id === null || row.project_policy_revision_id === undefined
      ? null : String(row.project_policy_revision_id),
    executionContractJson: row.execution_contract_json === null || row.execution_contract_json === undefined
      ? null : String(row.execution_contract_json),
    contractRevision: Number(row.contract_revision),
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

function mapAgentExecution(row: Record<string, unknown>): AgentExecutionRecord {
  return {
    runId: String(row.run_id), agentId: String(row.agent_id), taskId: row.task_id === null ? null : String(row.task_id),
    role: String(row.role) as AgentExecutionRecord['role'], backend: String(row.backend) as AgentExecutionRecord['backend'],
    model: row.model === null ? null : String(row.model), status: String(row.status) as AgentExecutionRecord['status'],
    sessionId: row.session_id === null ? null : String(row.session_id), logPath: String(row.log_path),
    startedAt: String(row.started_at), updatedAt: String(row.updated_at), finishedAt: row.finished_at === null ? null : String(row.finished_at)
  };
}

function mapEvent(row: Record<string, unknown>): RunEventRecord {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    eventType: String(row.event_type),
    payload: row.payload_json === null ? null : JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at)
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
        project_id TEXT,
        project_policy_revision_id TEXT,
        execution_contract_json TEXT,
        contract_revision INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS agent_executions (
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task_id TEXT,
        role TEXT NOT NULL,
        backend TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        session_id TEXT,
        log_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (run_id, agent_id),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS execution_contract_revisions (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, revision),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_tasks_run_status ON tasks(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
      CREATE INDEX IF NOT EXISTS idx_agent_executions_run ON agent_executions(run_id, started_at);
    `);
    this.addColumnIfMissing('runs', 'roles_json', 'TEXT');
    this.addColumnIfMissing('runs', 'project_id', 'TEXT');
    this.addColumnIfMissing('runs', 'project_policy_revision_id', 'TEXT');
    this.addColumnIfMissing('runs', 'execution_contract_json', 'TEXT');
    this.addColumnIfMissing('runs', 'contract_revision', 'INTEGER NOT NULL DEFAULT 0');
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
    projectId?: string | null;
    projectPolicyRevisionId?: string | null;
    executionContractJson?: string | null;
    adapter: string;
  }): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO runs (
        id, repo_root, goal_file, base_ref, base_sha, project_id, project_policy_revision_id,
        execution_contract_json, contract_revision, adapter, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)
    `).run(
      input.id,
      input.repoRoot,
      input.goalFile,
      input.baseRef,
      input.baseSha,
      input.projectId ?? null,
      input.projectPolicyRevisionId ?? null,
        input.executionContractJson ?? null,
        input.executionContractJson === undefined || input.executionContractJson === null ? 0 : 1,
        input.adapter,
      timestamp,
      timestamp
    );
    if (input.executionContractJson !== undefined && input.executionContractJson !== null) {
      this.db.prepare(`
        INSERT INTO execution_contract_revisions (run_id, revision, contract_json, created_at)
        VALUES (?, 1, ?, ?)
      `).run(input.id, input.executionContractJson, timestamp);
    }
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

  listContractRevisions(runId: string): Array<{ revision: number; contractJson: string; createdAt: string }> {
    return (this.db.prepare(`
      SELECT revision, contract_json, created_at
      FROM execution_contract_revisions WHERE run_id = ? ORDER BY revision
    `).all(runId) as Record<string, unknown>[]).map((row) => ({
      revision: Number(row.revision), contractJson: String(row.contract_json), createdAt: String(row.created_at)
    }));
  }

  appendContractRevision(runId: string, contractJson: string): number {
    const run = this.getRun(runId);
    if (run.executionContractJson === null) throw new Error(`Run ${runId} has no execution contract`);
    const revision = run.contractRevision + 1;
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        INSERT INTO execution_contract_revisions (run_id, revision, contract_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(runId, revision, contractJson, timestamp);
      this.db.prepare(`
        UPDATE runs SET execution_contract_json = ?, contract_revision = ?, updated_at = ? WHERE id = ?
      `).run(contractJson, revision, timestamp, runId);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return revision;
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

  replaceTaskSpec(runId: string, spec: TaskSpec): void {
    const timestamp = now();
    this.db.prepare(`
      UPDATE tasks
      SET title = ?, spec_json = ?, status = 'pending', phase = NULL, branch = NULL, worktree = NULL,
          start_sha = NULL, commit_sha = NULL, attempts = 0, review_cycles = 0, last_error = NULL,
          review_json = NULL, finished_at = NULL, updated_at = ?
      WHERE run_id = ? AND task_id = ?
    `).run(spec.title, JSON.stringify(spec), timestamp, runId, spec.id);
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

  listEvents(runId: string, afterEventId = 0, limit = 100): RunEventRecord[] {
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) {
      throw new Error('afterEventId must be a non-negative integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('limit must be an integer between 1 and 1000');
    }
    return (this.db.prepare(`
      SELECT * FROM events
      WHERE run_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(runId, afterEventId, limit) as Record<string, unknown>[]).map(mapEvent);
  }

  startAgentExecution(input: {
    runId: string; agentId: string; taskId?: string | undefined; role: string; backend: string; model?: string | undefined; logPath: string;
  }): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_executions (
        run_id, agent_id, task_id, role, backend, model, status, session_id, log_path, started_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, NULL)
    `).run(input.runId, input.agentId, input.taskId ?? null, input.role, input.backend, input.model ?? null, input.logPath, timestamp, timestamp);
  }

  updateAgentExecution(runId: string, agentId: string, patch: Partial<{
    status: AgentExecutionRecord['status']; sessionId: string; finishedAt: string | null;
  }>): void {
    const entries = Object.entries(patch);
    if (entries.length === 0) return;
    const columns: Record<string, string> = { status: 'status', sessionId: 'session_id', finishedAt: 'finished_at' };
    const sets = entries.map(([key]) => `${columns[key]} = ?`);
    const values = entries.map(([, value]) => value);
    sets.push('updated_at = ?');
    values.push(now(), runId, agentId);
    this.db.prepare(`UPDATE agent_executions SET ${sets.join(', ')} WHERE run_id = ? AND agent_id = ?`).run(...values);
  }

  listAgentExecutions(runId: string): AgentExecutionRecord[] {
    return (this.db.prepare('SELECT * FROM agent_executions WHERE run_id = ? ORDER BY started_at, agent_id').all(runId) as Record<string, unknown>[]).map(mapAgentExecution);
  }

  getAgentExecution(runId: string, agentId: string): AgentExecutionRecord {
    const row = this.db.prepare('SELECT * FROM agent_executions WHERE run_id = ? AND agent_id = ?').get(runId, agentId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Agent execution not found: ${runId}/${agentId}`);
    return mapAgentExecution(row);
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
        lastError: 'Runner restarted while the task was active. The interrupted attempt will be discarded before retrying.'
      });
      this.addEvent(runId, row.task_id, 'TASK_RECOVERED');
    }
  }
}
