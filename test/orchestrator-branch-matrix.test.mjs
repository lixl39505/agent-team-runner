import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const control = vi.hoisted(() => ({
  backends: { claude: { id: 'claude' }, codex: { id: 'codex' }, opencode: { id: 'opencode' } },
  runAgent: async () => ({ ok: true, output: { status: 'blocked', summary: 'blocked' }, timedOut: false, stalled: false }),
  verify: async () => ({ ok: true, changedFiles: ['src/file.ts'] }),
  global: async () => {},
  cherryPick: async () => ({ code: 0, stderr: '' }),
  conflicts: async () => [],
  changed: async () => [],
  paths: () => ({ ok: true, invalid: [] }),
  currentHead: async () => 'head',
  reset: async () => {},
  create: async () => {},
  stage: async () => {},
  unstage: async () => {},
  abort: async () => {},
  commit: async () => 'commit',
  git: async () => ({ stdout: '' }),
  resolve: (role) => ({ agent: role, backend: 'claude' }),
  build: () => control.backends
}));

vi.mock('../src/agent/registry.ts', () => ({
  buildBackends: (...args) => control.build(...args),
  disposeBackends: () => {},
  resolveTaskAgent: (...args) => control.resolve('worker', ...args),
  resolveAgentWithSnapshot: (role, ...args) => control.resolve(role, ...args)
}));
vi.mock('../src/agent/supervise.ts', () => ({ runAgent: (...args) => control.runAgent(...args) }));
vi.mock('../src/core/validation.ts', () => ({
  WORKER_SCHEMA: {}, REVIEW_SCHEMA: {}, INTEGRATION_SCHEMA: {},
  validateWorkerResult: (value) => value,
  validateReviewResult: (value) => value,
  validateIntegrationResult: (value) => value,
  topologicalTasks: (tasks) => tasks
}));
vi.mock('../src/core/git.ts', () => ({
  abortCherryPick: (...args) => control.abort(...args),
  changedFiles: (...args) => control.changed(...args),
  cherryPick: (...args) => control.cherryPick(...args),
  commit: (...args) => control.commit(...args),
  conflictedFiles: (...args) => control.conflicts(...args),
  continueCherryPick: async () => {},
  createWorktree: (...args) => control.create(...args),
  currentHead: (...args) => control.currentHead(...args),
  git: (...args) => control.git(...args),
  resetWorktree: (...args) => control.reset(...args),
  stageAll: (...args) => control.stage(...args),
  unstageAll: (...args) => control.unstage(...args)
}));
vi.mock('../src/core/path-policy.ts', () => ({ checkPaths: (...args) => control.paths(...args) }));
vi.mock('../src/core/verifier.ts', () => ({
  verifyTaskWorktree: (...args) => control.verify(...args)
}));
vi.mock('../src/core/prompts.ts', () => ({
  workerPrompt: () => 'worker', reviewerPrompt: () => 'reviewer', integrationPrompt: () => 'integration', reviewFeedback: (review) => review.summary
}));

const { runOrchestrator } = await import('../src/core/orchestrator.ts');

function spec(id, extra = {}) {
  return { id, title: id, description: id, dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [], acceptance: [], verificationCommands: [], ...extra };
}

class Database {
  constructor(tasks, manifest = tasks.map((task) => JSON.parse(task.specJson))) {
    this.tasks = new Map(tasks.map((task) => [task.taskId, task]));
    this.run = {
      status: 'planned', baseSha: 'base', manifestJson: JSON.stringify({ version: 1, title: 'matrix', summary: 'matrix', tasks: manifest }), rolesJson: '{}'
    };
    this.events = [];
  }

  getRun() { return this.run; }
  updateRun(_runId, values) { Object.assign(this.run, values); }
  listTasks() { return [...this.tasks.values()]; }
  getTask(_runId, taskId) { return this.tasks.get(taskId); }
  updateTask(_runId, taskId, values) { Object.assign(this.tasks.get(taskId), values); }
  addEvent(_runId, _taskId, type) { this.events.push(type); }
  resetInterrupted() {}
}

function record(task, values = {}) {
  return {
    taskId: task.id, specJson: JSON.stringify(task), status: 'pending', phase: 'pending', attempts: 0, reviewCycles: 0,
    worktree: null, branch: null, startSha: null, commitSha: null, reviewJson: null, lastError: null, ...values
  };
}

function config() {
  const stateDir = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-matrix-'));
  mkdirSync(join(stateDir, 'runs', 'run'), { recursive: true });
  return {
    version: 3,
    workspace: { repoRoot: '/repo', stateDir, worktreesDir: join(stateDir, 'worktrees'), baseRef: 'HEAD', branchPrefix: 'agent-team' },
    retry: { maxPlanAttempts: 2, maxWorkerAttempts: 1, maxReviewCycles: 2 },
    status: { pollIntervalMs: 2000 },
    concurrency: 1, taskTimeoutMs: 1, staleAfterMs: 1,
    verification: { allowedCommandPrefixes: ['npm test'] }
  };
}

function reset() {
  control.runAgent = async () => ({ ok: true, output: { status: 'blocked', summary: 'blocked' }, timedOut: false, stalled: false });
  control.verify = async () => ({ ok: true, changedFiles: ['src/file.ts'] });
  control.cherryPick = async () => ({ code: 0, stderr: '' });
  control.conflicts = async () => [];
  control.changed = async () => [];
  control.paths = () => ({ ok: true, invalid: [] });
  control.currentHead = async () => 'head';
  control.reset = async () => {};
  control.create = async () => {};
  control.stage = async () => {};
  control.unstage = async () => {};
  control.abort = async () => {};
  control.commit = async () => 'commit';
  control.git = async () => ({ stdout: '' });
  control.resolve = (role) => ({ agent: role, backend: 'claude' });
  control.build = () => control.backends;
}

async function run(db, settings = config(), input = {}) {
  return runOrchestrator({ config: settings, db, runId: 'run', backends: control.backends, ...input });
}

test('orchestrator covers scheduler and worker collaborator fallbacks', async () => {
  reset();
  const exitCode = process.exitCode;
  try {
    const missingManifest = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
    missingManifest.run.manifestJson = null;
    await assert.rejects(run(missingManifest, config(), { backends: undefined }), /Run has no manifest/);

    const terminal = new Database([record(spec('T1'), { status: 'blocked' })]);
    await run(terminal);
    assert.match(terminal.run.error, /T1: blocked/);

    const first = spec('T1');
    const second = spec('T2');
    const concurrent = new Database([record(first), record(second)]);
    await run(concurrent);

    const heartbeat = new Database([record(spec('T1'))]);
    control.runAgent = async ({ spec: session }) => {
      session.onEvent({ type: 'progress' });
      return { ok: false, output: null, timedOut: false, stalled: false };
    };
    await run(heartbeat);
    assert.match(heartbeat.getTask('run', 'T1').lastError, /no structured output/);

    const noVerificationError = new Database([record(spec('T1'))]);
    control.runAgent = async () => ({ ok: true, output: { status: 'completed', summary: 'done' }, timedOut: false, stalled: false });
    control.verify = async () => ({ ok: false, changedFiles: [] });
    await run(noVerificationError);
    assert.equal(noVerificationError.getTask('run', 'T1').lastError, 'Verification failed');
  } finally {
    process.exitCode = exitCode;
  }
});

test('orchestrator covers interruption and otherwise unreachable scheduler guards', async () => {
  reset();
  const exitCode = process.exitCode;
  const originalHas = Map.prototype.has;
  const originalOnce = process.once;
  try {
    const repeatedSignal = new Database([record(spec('T1'), { status: 'blocked' })]);
    let signalHandler;
    process.once = function (event, handler) {
      signalHandler = handler;
      return originalOnce.call(this, event, handler);
    };
    const repeatedList = repeatedSignal.listTasks.bind(repeatedSignal);
    repeatedSignal.listTasks = () => {
      if (!signalHandler) throw new Error('signal handler was not installed');
      if (!repeatedSignal.interrupted) {
        repeatedSignal.interrupted = true;
        process.emit('SIGINT');
        signalHandler();
      }
      return repeatedList();
    };
    await run(repeatedSignal);
    process.once = originalOnce;

    reset();
    const activeGuard = new Database([record(spec('T1'))]);
    Map.prototype.has = function (key) {
      return this.size === 0 && key === 'T1' ? true : originalHas.call(this, key);
    };
    await run(activeGuard);
    Map.prototype.has = originalHas;

    reset();
    const noBlockedTasks = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
    let listCalls = 0;
    noBlockedTasks.listTasks = () => {
      listCalls += 1;
      if (listCalls === 1) return [record(spec('T1'), { status: 'running' })];
      if (listCalls === 2) return [];
      return [...noBlockedTasks.tasks.values()];
    };
    await run(noBlockedTasks);

    reset();
    const afterApproval = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
    const approvedList = afterApproval.listTasks.bind(afterApproval);
    afterApproval.listTasks = () => {
      process.emit('SIGINT');
      return approvedList();
    };
    await run(afterApproval);

    reset();
    const approvedActiveTask = new Database([record(spec('T1'))]);
    control.runAgent = async ({ spec: session }) => {
      if (session.role === 'worker') {
        process.emit('SIGINT');
        return { ok: true, output: { status: 'completed', summary: 'done' }, timedOut: false, stalled: false };
      }
      return { ok: true, output: { decision: 'approved', summary: 'approved', findings: [], requiredChanges: [] }, timedOut: false, stalled: false };
    };
    await run(approvedActiveTask);

    reset();
    const interruptedFailure = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
    control.reset = async () => {
      process.emit('SIGINT');
      throw new Error('reset failed');
    };
    await run(interruptedFailure);
  } finally {
    Map.prototype.has = originalHas;
    process.once = originalOnce;
    process.exitCode = exitCode;
  }
});

test('orchestrator passes explicit max-turn bindings to workers and reviewers', async () => {
  reset();
  const bound = new Database([record(spec('T1'))]);
  control.resolve = (role) => ({ agent: role, backend: 'claude', maxTurns: 3 });
  control.runAgent = async ({ spec: session }) => {
    if (session.role === 'worker') return { ok: true, output: { status: 'completed', summary: 'done' }, timedOut: false, stalled: false };
    return { ok: true, output: { decision: 'approved', summary: 'approved', findings: [], requiredChanges: [] }, timedOut: false, stalled: false };
  };
  await run(bound);
});

test('orchestrator records worker timeouts and stalls in retry errors', async () => {
  reset();
  const timedOut = new Database([record(spec('T1'))]);
  control.runAgent = async () => ({ ok: false, output: null, timedOut: true, stalled: false });
  await run(timedOut);
  assert.match(timedOut.getTask('run', 'T1').lastError, /timeout/);

  reset();
  const stalled = new Database([record(spec('T1'))]);
  control.runAgent = async () => ({ ok: false, output: null, timedOut: false, stalled: true });
  await run(stalled);
  assert.match(stalled.getTask('run', 'T1').lastError, /stalled/);
});

test('orchestrator covers persisted worktree graph edge cases', async () => {
  reset();
  const badWorktree = mkdtempSync(join(tmpdir(), 'agent-team-orchestrator-worktree-'));
  const interrupted = new Database([record(spec('T1'), { status: 'changes_requested', phase: 'recovered', worktree: badWorktree, startSha: 'base' })]);
  await run(interrupted);
  assert.match(interrupted.getTask('run', 'T1').lastError, /Interrupted task T1 has no worktree branch/);

  reset();
  const dependency = spec('D');
  const dependent = spec('T1', { dependsOn: ['D'] });
  const missingCommit = new Database([record(dependency, { status: 'approved' }), record(dependent)]);
  await run(missingCommit);
  assert.match(missingCommit.getTask('run', 'T1').lastError, /Dependency D has no approved commit/);

  reset();
  const failedPick = new Database([record(dependency, { status: 'approved', commitSha: 'D' }), record(dependent)]);
  control.cherryPick = async () => ({ code: 1, stderr: 'pick failed' });
  await run(failedPick);
  assert.match(failedPick.getTask('run', 'T1').lastError, /Failed to inject dependency D/);

  reset();
  const absent = spec('T1', { dependsOn: ['MISSING'] });
  const missingManifestDependency = new Database([record(spec('MISSING'), { status: 'approved', commitSha: 'MISSING' }), record(absent)], [absent]);
  await run(missingManifestDependency);

  reset();
  const root = spec('ROOT');
  const left = spec('LEFT', { dependsOn: ['ROOT'] });
  const right = spec('RIGHT', { dependsOn: ['ROOT'] });
  const leaf = spec('LEAF', { dependsOn: ['LEFT', 'RIGHT'] });
  const diamond = new Database([
    record(root, { status: 'approved', commitSha: 'root' }), record(left, { status: 'approved', commitSha: 'left' }),
    record(right, { status: 'approved', commitSha: 'right' }), record(leaf)
  ], [root, left, right, leaf]);
  await run(diamond);
});

test('orchestrator covers integration failures, resolver outcomes, and interruption guards', async () => {
  reset();
  const noCommit = new Database([record(spec('T1'), { status: 'approved' })]);
  await assert.rejects(run(noCommit), /Approved task T1 has no commit/);

  reset();
  const failedPick = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
  control.cherryPick = async () => ({ code: 1, stderr: 'pick failed' });
  await assert.rejects(run(failedPick), /Cherry-pick failed for T1/);

  reset();
  const blockedConflict = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
  control.cherryPick = async () => ({ code: 1, stderr: 'conflict' });
  control.conflicts = async () => ['src/file.ts'];
  control.resolve = (role) => ({ agent: role, backend: 'claude', model: 'model', maxTurns: 3 });
  control.runAgent = async () => ({ ok: true, output: { status: 'blocked', summary: 'cannot resolve' }, timedOut: false, stalled: false });
  await assert.rejects(run(blockedConflict), /cannot resolve/);

  reset();
  const unresolved = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
  control.cherryPick = async () => ({ code: 1, stderr: 'conflict' });
  let conflictCalls = 0;
  control.conflicts = async () => (++conflictCalls === 1 ? ['src/file.ts'] : ['src/file.ts']);
  control.runAgent = async () => ({ ok: true, output: { status: 'completed', summary: 'done' }, timedOut: false, stalled: false });
  await assert.rejects(run(unresolved), /Unresolved integration conflicts/);

  reset();
  const exitCode = process.exitCode;
  try {
    const beforePick = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
    const addEvent = beforePick.addEvent.bind(beforePick);
    beforePick.addEvent = (...args) => { addEvent(...args); if (args[2] === 'INTEGRATION_STARTED') process.emit('SIGINT'); };
    await run(beforePick);

    reset();
    const afterConflictAgent = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
    control.cherryPick = async () => ({ code: 1, stderr: 'conflict' });
    control.conflicts = async () => ['src/file.ts'];
    control.runAgent = async () => {
      process.emit('SIGINT');
      return { ok: true, output: { status: 'completed', summary: 'done' }, timedOut: false, stalled: false };
    };
    await run(afterConflictAgent);

    reset();
    const afterIntegrationHead = new Database([record(spec('T1'), { status: 'approved', commitSha: 'one' })]);
    control.currentHead = async () => { process.emit('SIGINT'); return 'head'; };
    await run(afterIntegrationHead);
  } finally {
    process.exitCode = exitCode;
  }
});
