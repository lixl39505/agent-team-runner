// executions repository — HerdrExecutionRef persistence. prompt_sent_at is
// the single guard against re-prompting a recoverable execution.

import type { SQLQueryBindings } from 'bun:sqlite';
import type { SqliteDb } from './db.ts';
import { nowIso } from './ids.ts';
import type { AgentKind, ExecutionRecord, ExecutionRole, ExecutionStatus, HerdrAgentState } from '../core/types.ts';

interface ExecutionRow {
  id: string;
  run_id: string;
  task_id: string;
  role: string;
  attempt_no: number;
  cycle_no: number;
  agent_name: string;
  agent_kind: string;
  model: string | null;
  status: string;
  prompt_sent_at: string | null;
  prompt_digest: string | null;
  result_path: string | null;
  result_digest: string | null;
  result_json: string | null;
  result_received_at: string | null;
  native_session_ref: string | null;
  pane_id: string | null;
  tab_id: string | null;
  workspace_id: string | null;
  pane_state: string;
  last_agent_state: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

function toRecord(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    role: row.role as ExecutionRole,
    attemptNo: row.attempt_no,
    cycleNo: row.cycle_no,
    agentName: row.agent_name,
    agentKind: row.agent_kind as AgentKind,
    model: row.model,
    status: row.status as ExecutionStatus,
    promptSentAt: row.prompt_sent_at,
    promptDigest: row.prompt_digest,
    resultPath: row.result_path,
    resultDigest: row.result_digest,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    resultReceivedAt: row.result_received_at,
    nativeSessionRef: row.native_session_ref,
    paneId: row.pane_id,
    tabId: row.tab_id,
    workspaceId: row.workspace_id,
    paneState: row.pane_state as ExecutionRecord['paneState'],
    lastAgentState: row.last_agent_state as HerdrAgentState | null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

export type NewExecution = Omit<ExecutionRecord, 'updatedAt' | 'resultDigest' | 'result' | 'resultReceivedAt'> &
  Partial<Pick<ExecutionRecord, 'resultDigest' | 'result' | 'resultReceivedAt'>>;

export function insertExecution(db: SqliteDb, record: NewExecution): ExecutionRecord {
  const updatedAt = nowIso();
  db.run(
    `INSERT INTO executions (id, run_id, task_id, role, attempt_no, cycle_no, agent_name, agent_kind, model,
                             status, prompt_sent_at, prompt_digest, result_path, pane_state, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.runId, record.taskId, record.role, record.attemptNo, record.cycleNo,
      record.agentName, record.agentKind, record.model, record.status,
      record.promptSentAt, record.promptDigest, record.resultPath, record.paneState,
      record.startedAt, updatedAt],
  );
  return {
    ...record,
    resultDigest: record.resultDigest ?? null,
    result: record.result ?? null,
    resultReceivedAt: record.resultReceivedAt ?? null,
    updatedAt,
  };
}

export function getExecution(db: SqliteDb, executionId: string): ExecutionRecord | null {
  const row = db.query<ExecutionRow, [string]>('SELECT * FROM executions WHERE id = ?').get(executionId);
  return row ? toRecord(row) : null;
}

export function listExecutions(db: SqliteDb, runId: string): ExecutionRecord[] {
  return (db.query<ExecutionRow, [string]>('SELECT * FROM executions WHERE run_id = ? ORDER BY started_at').all(runId))
    .map(toRecord);
}

export function listActiveExecutions(db: SqliteDb, runId: string): ExecutionRecord[] {
  return (
    db.query<ExecutionRow, [string]>(
      `SELECT * FROM executions WHERE run_id = ? AND status IN ('starting','running','blocked','result_pending')
       ORDER BY started_at`,
    ).all(runId)
  ).map(toRecord);
}

export function latestExecutionFor(db: SqliteDb, runId: string, taskId: string, role: ExecutionRole): ExecutionRecord | null {
  const row = db
    .query<ExecutionRow, [string, string, string]>(
      `SELECT * FROM executions WHERE run_id = ? AND task_id = ? AND role = ?
       ORDER BY attempt_no DESC, cycle_no DESC LIMIT 1`,
    )
    .get(runId, taskId, role);
  return row ? toRecord(row) : null;
}

export interface ExecutionPatch {
  status?: ExecutionStatus;
  promptSentAt?: string | null;
  promptDigest?: string | null;
  resultPath?: string | null;
  resultDigest?: string | null;
  result?: unknown | null;
  resultReceivedAt?: string | null;
  nativeSessionRef?: string | null;
  paneId?: string | null;
  tabId?: string | null;
  workspaceId?: string | null;
  paneState?: ExecutionRecord['paneState'];
  lastAgentState?: HerdrAgentState | null;
}

export function updateExecution(db: SqliteDb, executionId: string, patch: ExecutionPatch): void {
  const sets: string[] = [];
  const values: SQLQueryBindings[] = [];
  const push = (col: string, value: SQLQueryBindings): void => {
    sets.push(`${col} = ?`);
    values.push(value);
  };
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.promptSentAt !== undefined) push('prompt_sent_at', patch.promptSentAt);
  if (patch.promptDigest !== undefined) push('prompt_digest', patch.promptDigest);
  if (patch.resultPath !== undefined) push('result_path', patch.resultPath);
  if (patch.resultDigest !== undefined) push('result_digest', patch.resultDigest);
  if (patch.result !== undefined) push('result_json', patch.result === null ? null : JSON.stringify(patch.result));
  if (patch.resultReceivedAt !== undefined) push('result_received_at', patch.resultReceivedAt);
  if (patch.nativeSessionRef !== undefined) push('native_session_ref', patch.nativeSessionRef);
  if (patch.paneId !== undefined) push('pane_id', patch.paneId);
  if (patch.tabId !== undefined) push('tab_id', patch.tabId);
  if (patch.workspaceId !== undefined) push('workspace_id', patch.workspaceId);
  if (patch.paneState !== undefined) push('pane_state', patch.paneState);
  if (patch.lastAgentState !== undefined) push('last_agent_state', patch.lastAgentState);
  const terminal = patch.status !== undefined && ['completed', 'failed', 'abandoned'].includes(patch.status);
  push('updated_at', nowIso());
  push('finished_at', terminal ? nowIso() : null);
  values.push(executionId);
  db.run(`UPDATE executions SET ${sets.join(', ')} WHERE id = ?`, values);
}
