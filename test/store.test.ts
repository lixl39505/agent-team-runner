import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase, inTransaction, inSavepoint, type SqliteDb } from '../src/store/db.ts';
import { insertRun, getRun, updateRunStatus, listRuns, appendContractRevision, getContractRevision, clearRevisionPending } from '../src/store/runs.ts';
import { insertTask, getTask, updateTask, listTasksByStatus } from '../src/store/tasks.ts';
import { addEvent, listEvents } from '../src/store/events.ts';
import { insertExecution, updateExecution, listActiveExecutions, latestExecutionFor } from '../src/store/executions.ts';
import { insertResource, markResourceState, listActiveResources } from '../src/store/resources.ts';
import { acquireLease, heartbeat, releaseLease, leaseIsAlive } from '../src/store/lease.ts';
import { recordCleanupStep, latestCleanupSteps } from '../src/store/cleanup.ts';
import { cleanupTempDir, makeTempDir, minimalContract } from './helpers.ts';
import type { ExecutionContract } from '../src/core/types.ts';

let home: string;
let db: SqliteDb;
let contract: ExecutionContract;

beforeAll(async () => {
  home = await makeTempDir('ateam-store-');
  db = openDatabase(join(home, 'state.sqlite'));
  contract = validate(minimalContract());
});

afterAll(async () => {
  db.close();
  await cleanupTempDir(home);
});

function validate(doc: unknown): ExecutionContract {
  // avoid importing contract.ts just for casting in store tests
  return doc as ExecutionContract;
}

describe('runs repository', () => {
  test('insert/get/update roundtrip + revision append', () => {
    const run = insertRun(db, { id: 'r-20261003-aaaaaa', contract, baseSha: 'sha0', status: 'queued' });
    expect(getRun(db, run.id)?.status).toBe('queued');
    expect(getContractRevision(db, run.id)?.tasks).toHaveLength(2);

    updateRunStatus(db, run.id, 'running');
    expect(getRun(db, run.id)?.status).toBe('running');
    expect(getRun(db, run.id)?.finishedAt).toBeNull();

    const rev = appendContractRevision(db, run.id, { ...contract, tasks: contract.tasks.slice(0, 1) });
    expect(rev).toBe(2);
    expect(getRun(db, run.id)?.revisionPending).toBe(true);
    expect(getContractRevision(db, run.id)?.tasks).toHaveLength(1);
    clearRevisionPending(db, run.id);
    expect(getRun(db, run.id)?.revisionPending).toBe(false);

    updateRunStatus(db, run.id, 'done');
    expect(getRun(db, run.id)?.finishedAt).not.toBeNull();
    expect(listRuns(db, { nonTerminalOnly: true })).toHaveLength(0);
    expect(listRuns(db)).toHaveLength(1);
  });
});

describe('tasks repository', () => {
  test('insert/patch/status filter', () => {
    const runId = 'r-20261003-bbbbbb';
    insertRun(db, { id: runId, contract, baseSha: 's', status: 'running' });
    insertTask(db, runId, contract.tasks[0]!);
    insertTask(db, runId, contract.tasks[1]!);

    updateTask(db, runId, 'API', { status: 'running', branch: 'ateam/x/API', worktreePath: '/wt/api' });
    const task = getTask(db, runId, 'API')!;
    expect(task.status).toBe('running');
    expect(task.branch).toBe('ateam/x/API');
    expect(task.spec.id).toBe('API');

    updateTask(db, runId, 'API', { review: { status: 'approved' } });
    expect(getTask(db, runId, 'API')?.review).toEqual({ status: 'approved' });

    expect(listTasksByStatus(db, runId, ['pending'])).toHaveLength(1);
    expect(listTasksByStatus(db, runId, ['running', 'pending'])).toHaveLength(2);
  });
});

describe('executions repository', () => {
  test('insert/active/latest', () => {
    const runId = 'r-20261003-bbbbbb';
    insertExecution(db, {
      id: `${runId}-API-w-a1c0`, runId, taskId: 'API', role: 'worker', attemptNo: 1, cycleNo: 0,
      agentName: 'at-aaaa-api-r1', agentKind: 'claude', model: null,
      status: 'running', promptSentAt: '2026-10-03T00:00:00Z', promptDigest: 'd',
      resultPath: '/results/API/worker-a1c0.json',
      nativeSessionRef: null, paneId: 'w1:p2', tabId: 'w1:t', workspaceId: 'w1',
      paneState: 'open', lastAgentState: null, startedAt: '2026-10-03T00:00:00Z', finishedAt: null,
    });
    insertExecution(db, {
      id: `${runId}-API-v-a1c1`, runId, taskId: 'API', role: 'reviewer', attemptNo: 1, cycleNo: 1,
      agentName: 'at-aaaa-api-v1', agentKind: 'codex', model: null,
      status: 'starting', promptSentAt: null, promptDigest: null, resultPath: null,
      nativeSessionRef: null, paneId: null, tabId: null, workspaceId: null,
      paneState: 'open', lastAgentState: null, startedAt: '2026-10-03T00:01:00Z', finishedAt: null,
    });

    expect(listActiveExecutions(db, runId)).toHaveLength(2);
    const latest = latestExecutionFor(db, runId, 'API', 'worker')!;
    expect(latest.id).toBe(`${runId}-API-w-a1c0`);
    expect(latest.promptSentAt).not.toBeNull();

    updateExecution(db, `${runId}-API-w-a1c0`, { status: 'completed', result: { status: 'completed' }, paneState: 'closed_success' });
    expect(listActiveExecutions(db, runId)).toHaveLength(1);
    expect(latestExecutionFor(db, runId, 'API', 'worker')?.status).toBe('completed');
  });
});

describe('resources + lease + cleanup', () => {
  test('resource lifecycle', () => {
    const runId = 'r-20261003-cccccc';
    insertRun(db, { id: runId, contract, baseSha: 's', status: 'running' });
    insertResource(db, { runId, taskId: 'API', kind: 'workspace', herdrId: 'w9', branch: 'ateam/x/API', path: '/wt/api' });
    insertResource(db, { runId, kind: 'pane', herdrId: 'w9:p1' });
    expect(listActiveResources(db, runId)).toHaveLength(2);
    markResourceState(db, 'workspace', 'w9', 'reclaimed');
    expect(listActiveResources(db, runId)).toHaveLength(1);
    expect(listActiveResources(db, runId)[0]!.herdrId).toBe('w9:p1');
  });

  test('lease acquire/heartbeat/release + stale takeover', async () => {
    const runId = 'r-20261003-dddddd';
    expect(acquireLease(db, runId)).toBe(true);
    expect(leaseIsAlive(db, runId)).toBe(true);
    // a different live holder cannot be stolen
    db.run("UPDATE runner_leases SET holder = '99999@other' WHERE run_id = ?", [runId]);
    expect(acquireLease(db, runId)).toBe(false);
    heartbeat(db, runId); // heartbeat only applies to own holder; row keeps other holder alive
    expect(acquireLease(db, runId)).toBe(false);
    // stale heartbeat allows takeover
    db.run("UPDATE runner_leases SET heartbeat_at = '2020-01-01T00:00:00Z' WHERE run_id = ?", [runId]);
    expect(acquireLease(db, runId)).toBe(true);
    heartbeat(db, runId);
    releaseLease(db, runId);
    expect(leaseIsAlive(db, runId)).toBe(false);
    db.run("UPDATE runner_leases SET holder = '99999@other' WHERE run_id = ?", [runId]);
    expect(acquireLease(db, runId)).toBe(true);
  });

  test('cleanup audit resume point', () => {
    const runId = 'r-20261003-eeeeee';
    insertRun(db, { id: runId, contract, baseSha: 's', status: 'integrating' });
    recordCleanupStep(db, { runId, taskId: 'API', step: 'close_pane', status: 'ok' });
    recordCleanupStep(db, { runId, taskId: 'API', step: 'remove_worktree', status: 'failed', detail: { reason: 'busy' } });
    const latest = latestCleanupSteps(db, runId, 'API');
    expect(latest.get('close_pane')?.status).toBe('ok');
    expect(latest.get('remove_worktree')?.status).toBe('failed');
    expect(latest.get('delete_branch')).toBeUndefined();
  });
});

describe('events', () => {
  test('append and list in order', () => {
    const runId = 'r-20261003-ffffff';
    insertRun(db, { id: runId, contract, baseSha: 's', status: 'running' });
    addEvent(db, runId, 'RUN_CREATED', { payload: { a: 1 } });
    addEvent(db, runId, 'TASK_STATUS_CHANGED', { taskId: 'API', payload: { to: 'running' } });
    addEvent(db, runId, 'TASK_STATUS_CHANGED', { taskId: 'WEB', payload: { to: 'pending' } });
    const events = listEvents(db, runId);
    expect(events.map((e) => e.eventType)).toEqual(['RUN_CREATED', 'TASK_STATUS_CHANGED', 'TASK_STATUS_CHANGED']);
    expect(listEvents(db, runId, { taskId: 'API' })).toHaveLength(1);
  });
});

describe('transactions', () => {
  test('inTransaction rolls back on throw', () => {
    const runId = 'r-20261003-aaaaaa';
    expect(() =>
      inTransaction(db, () => {
        updateRunStatus(db, runId, 'failed');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getRun(db, runId)?.status).toBe('done');
  });

  test('savepoint releases on success', () => {
    const out = inSavepoint(db, 'sp_test', () => 42);
    expect(out).toBe(42);
  });
});
