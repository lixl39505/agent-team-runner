import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateDatabase } from '../src/core/db.ts';
import {
  disposeBackends,
  parseSnapshot,
  resolveAgent,
  resolveAgentByName,
  resolveAgentWithSnapshot,
  resolveTaskAgent,
  snapshotAgents
} from '../src/agent/registry.ts';
import { unsupportedNativeWindowsSandbox } from '../src/agent/platform.ts';

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-db-registry-final-'));
  const instance = new StateDatabase(join(directory, 'nested', 'state.sqlite'));
  onTestFinished(() => {
    instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return instance;
}

function agentConfig(overrides = {}) {
  return {
    defaultAgent: 'default',
    agents: {
      default: { backend: 'claude', model: 'default-model' },
      worker: { backend: 'codex', model: 'worker-model', maxTurns: 2 }
    },
    roles: {
      lead: 'opencode.inline-lead',
      worker: 'worker'
    },
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    id: 'T001',
    title: 'Task',
    description: 'Task description',
    dependsOn: [],
    allowedPaths: ['src/**'],
    blockedPaths: [],
    acceptance: [],
    verificationCommands: [],
    ...overrides
  };
}

test('StateDatabase maps nullable fields, persists patches, and recovers active tasks', (t) => {
  const db = database(t);
  db.createRun({
    id: 'run-1',
    repoRoot: '/repo',
    goalFile: '/repo/GOAL.md',
    baseRef: 'main',
    baseSha: 'abc123',
    adapter: 'claude'
  });

  const created = db.getRun('run-1');
  assert.equal(created.manifestJson, null);
  assert.equal(created.rolesJson, null);
  assert.equal(created.integrationBranch, null);
  assert.equal(created.integrationWorktree, null);
  assert.equal(created.integrationCommit, null);
  assert.equal(created.error, null);
  assert.equal(created.finishedAt, null);
  assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.throws(() => db.getRun('missing'), /Run not found: missing/);

  db.updateRun('run-1', {});
  db.updateRun('run-1', {
    status: 'done',
    manifestJson: '{"tasks":[]}',
    rolesJson: '{"version":2}',
    integrationBranch: 'agent-team/run-1',
    integrationWorktree: '/repo/worktree',
    integrationCommit: 'def456',
    error: null,
    finishedAt: '2026-01-01T00:00:00.000Z'
  });
  assert.deepEqual(db.listRuns().map((run) => ({
    id: run.id,
    status: run.status,
    manifestJson: run.manifestJson,
    rolesJson: run.rolesJson,
    integrationBranch: run.integrationBranch,
    integrationWorktree: run.integrationWorktree,
    integrationCommit: run.integrationCommit,
    finishedAt: run.finishedAt
  })), [{
    id: 'run-1',
    status: 'done',
    manifestJson: '{"tasks":[]}',
    rolesJson: '{"version":2}',
    integrationBranch: 'agent-team/run-1',
    integrationWorktree: '/repo/worktree',
    integrationCommit: 'def456',
    finishedAt: '2026-01-01T00:00:00.000Z'
  }]);

  for (const id of ['T003', 'T001', 'T002', 'T004']) db.insertTask('run-1', task({ id }));
  assert.deepEqual(db.listTasks('run-1').map(({ taskId, phase, attempts, reviewCycles }) => ({ taskId, phase, attempts, reviewCycles })), [
    { taskId: 'T001', phase: null, attempts: 0, reviewCycles: 0 },
    { taskId: 'T002', phase: null, attempts: 0, reviewCycles: 0 },
    { taskId: 'T003', phase: null, attempts: 0, reviewCycles: 0 },
    { taskId: 'T004', phase: null, attempts: 0, reviewCycles: 0 }
  ]);
  assert.throws(() => db.getTask('run-1', 'missing'), /Task not found: run-1\/missing/);

  db.updateTask('run-1', 'T001', {
    status: 'running',
    phase: 'implementation',
    branch: 'agent-team/T001',
    worktree: '/repo/T001',
    startSha: 'start',
    commitSha: 'commit',
    attempts: 1,
    reviewCycles: 2,
    lastError: 'temporary',
    reviewJson: '{"decision":"approved"}',
    finishedAt: null
  });
  const updated = db.getTask('run-1', 'T001');
  assert.deepEqual({
    status: updated.status,
    phase: updated.phase,
    branch: updated.branch,
    worktree: updated.worktree,
    startSha: updated.startSha,
    commitSha: updated.commitSha,
    attempts: updated.attempts,
    reviewCycles: updated.reviewCycles,
    lastError: updated.lastError,
    reviewJson: updated.reviewJson,
    finishedAt: updated.finishedAt
  }, {
    status: 'running',
    phase: 'implementation',
    branch: 'agent-team/T001',
    worktree: '/repo/T001',
    startSha: 'start',
    commitSha: 'commit',
    attempts: 1,
    reviewCycles: 2,
    lastError: 'temporary',
    reviewJson: '{"decision":"approved"}',
    finishedAt: null
  });

  db.updateTask('run-1', 'T002', { status: 'verifying' });
  db.updateTask('run-1', 'T003', { status: 'reviewing' });
  db.updateTask('run-1', 'T004', {});
  db.addEvent('run-1', null, 'NO_PAYLOAD');
  db.addEvent('run-1', 'T004', 'WITH_PAYLOAD', { value: 1 });
  db.resetInterrupted('run-1');

  for (const id of ['T001', 'T002', 'T003']) {
    const recovered = db.getTask('run-1', id);
    assert.equal(recovered.status, 'changes_requested');
    assert.equal(recovered.phase, 'recovered');
    assert.match(recovered.lastError, /Runner restarted/);
  }
  assert.equal(db.getTask('run-1', 'T004').status, 'pending');
  const events = db.db.prepare('SELECT task_id, event_type, payload_json FROM events WHERE run_id = ? ORDER BY id').all('run-1');
  assert.equal(events.filter((event) => event.event_type === 'TASK_RECOVERED').length, 3);
  assert.deepEqual({ ...events.filter((event) => event.event_type === 'NO_PAYLOAD')[0] }, {
    task_id: null,
    event_type: 'NO_PAYLOAD',
    payload_json: null
  });
  assert.deepEqual({ ...events.filter((event) => event.event_type === 'WITH_PAYLOAD')[0] }, {
    task_id: 'T004',
    event_type: 'WITH_PAYLOAD',
    payload_json: '{"value":1}'
  });
});

test('registry resolves optional roles, snapshots, legacy snapshots, and fake disposers', () => {
  const config = agentConfig();
  assert.deepEqual(resolveAgent('lead', config), {
    agent: 'opencode.inline-lead', backend: 'opencode', model: 'inline-lead', source: 'roles.lead (inline)'
  });
  assert.equal(resolveAgent('reviewer', config).agent, 'default');
  assert.throws(() => resolveAgent('integrator', agentConfig({ agents: {}, defaultAgent: 'absent' })), /defaultAgent "absent"/);

  const snapshot = snapshotAgents(config);
  assert.equal(snapshot.roles.worker.agent, 'worker');
  assert.equal(snapshot.roles.reviewer.source, 'defaultAgent');
  const snapshotJson = JSON.stringify(snapshot);
  assert.deepEqual(parseSnapshot(snapshotJson), snapshot);
  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot(''), null);
  assert.equal(parseSnapshot('{bad json'), null);
  assert.equal(parseSnapshot(JSON.stringify({ worker: { cli: 'invalid' } })).roles.worker, undefined);
  assert.deepEqual(parseSnapshot(JSON.stringify({ worker: { cli: 'codex', model: 'legacy', source: 'old' } })).roles.worker, {
    agent: 'old', backend: 'codex', model: 'legacy', source: 'old'
  });

  const changed = agentConfig({
    agents: { default: { backend: 'claude' } },
    roles: { worker: 'default' }
  });
  assert.equal(resolveAgentWithSnapshot('worker', changed, snapshotJson).agent, 'worker');
  assert.equal(resolveAgentByName('worker', changed, snapshot.agents).model, 'worker-model');
  assert.equal(resolveTaskAgent(task({ agent: 'worker' }), changed, snapshotJson).agent, 'worker');
  assert.equal(resolveTaskAgent(task(), changed, snapshotJson).agent, 'worker');
  assert.throws(() => resolveAgentByName('missing', config), /unknown agent "missing"/);

  const disposed = [];
  disposeBackends({
    claude: { dispose: () => disposed.push('claude') },
    codex: {},
    opencode: { dispose: () => disposed.push('opencode') }
  });
  assert.deepEqual(disposed, ['claude', 'opencode']);
});

test('native Windows sandbox policy distinguishes POSIX, required Windows, and degraded Windows', () => {
  assert.deepEqual(unsupportedNativeWindowsSandbox('claude', 'require', 'linux'), {
    ok: true, degraded: false, detail: 'native Windows policy is not applicable'
  });
  assert.deepEqual(unsupportedNativeWindowsSandbox('opencode', 'allow-degraded', 'win32'), {
    ok: true,
    degraded: true,
    detail: 'opencode has no equivalent native Windows process sandbox; use WSL2 for strong isolation; unsandboxed execution was explicitly allowed'
  });
  assert.deepEqual(unsupportedNativeWindowsSandbox('claude', 'require', 'win32'), {
    ok: false,
    degraded: false,
    detail: 'claude has no equivalent native Windows process sandbox; use WSL2 for strong isolation, or set nativeWindowsSandbox: allow-degraded to opt in'
  });
});

let processTreeModuleId = 0;

async function fakeProcessTree({ platform, spawn, kill }) {
  const source = readFileSync(new URL('../src/agent/process-tree.ts', import.meta.url), 'utf8');
  globalThis.__agentTeamProcessTreeFakes = { platform, spawn, kill };
  const module = source
    .replace("import { spawn, type ChildProcess } from 'node:child_process';", 'const { spawn, ...process } = globalThis.__agentTeamProcessTreeFakes;')
    .replace("export function killProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {", 'export function killProcessTree(child, signal) {');
  try {
    return await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(module)}#${processTreeModuleId++}`);
  } finally {
    delete globalThis.__agentTeamProcessTreeFakes;
  }
}

test('killProcessTree uses fake POSIX groups and fake Windows taskkill fallback paths', async () => {
  const posixSignals = [];
  const posix = await fakeProcessTree({
    platform: 'linux',
    spawn: () => { throw new Error('POSIX must not spawn taskkill'); },
    kill: (pid, signal) => posixSignals.push([pid, signal])
  });
  posix.killProcessTree({ pid: 2468 }, 'SIGKILL');
  posix.killProcessTree({ pid: undefined }, 'SIGTERM');
  assert.deepEqual(posixSignals, [[-2468, 'SIGKILL']]);

  let onError;
  const calls = [];
  const windows = await fakeProcessTree({
    platform: 'win32',
    kill: () => { throw new Error('Windows must use taskkill'); },
    spawn: (command, args, options) => {
      calls.push([command, args, options]);
      return { once: (_event, listener) => { onError = listener; }, unref: () => calls.push('unref') };
    }
  });
  const fallbackSignals = [];
  windows.killProcessTree({ pid: 1357, kill: (signal) => fallbackSignals.push(signal) }, 'SIGTERM');
  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '1357', '/T', '/F'], { stdio: 'ignore', windowsHide: true }], 'unref']);
  assert.deepEqual(fallbackSignals, []);
  onError();
  assert.deepEqual(fallbackSignals, ['SIGTERM']);

  const throwingWindows = await fakeProcessTree({
    platform: 'win32',
    kill: () => {},
    spawn: () => { throw new Error('taskkill unavailable'); }
  });
  assert.doesNotThrow(() => throwingWindows.killProcessTree({ pid: 1, kill: () => { throw new Error('already gone'); } }, 'SIGKILL'));
});
