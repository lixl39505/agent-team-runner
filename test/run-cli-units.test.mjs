import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../src/core/git.ts';
import { assertHomeOutsideRepo, resolveAgentTeamHome } from '../src/core/home.ts';
import { DEFAULT_CONFIG } from '../src/core/defaults.ts';
import { StateDatabase } from '../src/core/db.ts';
import { ProjectRegistry } from '../src/core/project-registry.ts';
import { runnerConfigFromProjectPolicy } from '../src/core/project-runtime.ts';
import { validateExecutionContract, assertExecutionContractFields } from '../src/core/validation.ts';
import { createExecutionRun } from '../src/core/execution-run.ts';
import { applyContractRevision } from '../src/core/contract-revision.ts';
import { readHandoff, writeHandoff } from '../src/core/handoff.ts';
import { agentLogReadError, readAgentLog } from '../src/core/agent-log.ts';
import { cleanRunArtifacts } from '../src/core/run-clean.ts';
import { acquireRunLock, releaseRunLock } from '../src/core/run-lock.ts';
import { assertAllowedCommand, isAllowlistedCommand, isExactAllowlistEntry } from '../src/core/shell.ts';
import {
  ApprovalCollector,
  extractCommands,
  partitionGrants
} from '../src/core/approval-collector.ts';
import {
  blockersPath,
  classifyRunExit,
  contractBlockers,
  writeGrantsFileSync,
  grantsItemPath,
  handoffPath,
  pendingItemPath,
  readGrantsFileSync,
  readPendingFileSync,
  renderMachineSummary,
  renderRunSummary,
  writeBlockersFileSync,
  writePendingFileSync
} from '../src/core/run-exit.ts';
import { executeRunCommand, parseRunCommandArgs, readGrantDecisions, withRunId } from '../src/core/run-execute.ts';

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

const RUN_FAILED = { status: 'failed' };
const TASK_OK = { taskId: 'T001', status: 'approved', lastError: null };

test('classifyRunExit orders interrupted, done, contract blocks, and pending approvals', () => {
  assert.deepEqual(classifyRunExit({ run: { status: 'running' }, tasks: [], pending: [], interrupted: true }),
    { code: 130, kind: 'interrupted' });
  assert.deepEqual(classifyRunExit({ run: { status: 'done' }, tasks: [TASK_OK], pending: [], interrupted: false }),
    { code: 0, kind: 'done' });
  assert.deepEqual(classifyRunExit({
    run: { status: 'needs_attention' },
    tasks: [{ taskId: 'T001', status: 'blocked_on_contract', lastError: 'why' }],
    pending: [], interrupted: false
  }), { code: 11, kind: 'contract_blocked' });
  assert.deepEqual(classifyRunExit({
    run: { status: 'needs_attention' }, tasks: [{ taskId: 'T001', status: 'blocked' }], pending: [{ id: 'p1' }], interrupted: false
  }), { code: 10, kind: 'needs_approval' });
  assert.deepEqual(classifyRunExit({ run: RUN_FAILED, tasks: [TASK_OK], pending: [], interrupted: false }),
    { code: 1, kind: 'failed' });
});

test('run exit helpers render summaries and derive artifact paths', () => {
  const blockers = contractBlockers([
    { taskId: 'T002', title: 'Blocked task', attempts: 2, status: 'blocked_on_contract', lastError: 'reason text' },
    { taskId: 'T003', title: 'No reason', attempts: 1, status: 'blocked_on_contract', lastError: null }
  ]);
  assert.deepEqual(blockers.map((blocker) => blocker.reason), ['reason text', 'Worker requested a contract revision without a reason.']);

  const summary = renderRunSummary({
    runId: 'r1', kind: 'contract_blocked', code: 11, status: 'needs_attention',
    integrationBranch: 'agent-team/r1/integration', integrationCommit: 'abc',
    contractRevision: 2, tasks: [{ taskId: 'T001', status: 'approved' }],
    pending: [{ id: 'p1' }], blockers, pendingPath: '/tmp/pending.json', handoffPath: '/tmp/handoff.json'
  });
  assert.match(summary, /Run r1: contract_blocked \(exit 11\)/);
  assert.match(summary, /Contract blockers: T002, T003/);
  assert.match(summary, /Handoff:/);

  const plain = renderRunSummary({
    runId: 'r2', kind: 'done', code: 0, status: 'done', integrationBranch: null, integrationCommit: null,
    contractRevision: 1, tasks: [], pending: [], blockers: [], pendingPath: '/tmp/p2.json'
  });
  assert.match(plain, /Integration branch: none/);
  assert.doesNotMatch(plain, /Handoff:/);

  const machine = renderMachineSummary({
    runId: 'r1', kind: 'needs_approval', code: 10, status: 'running', contractRevision: 3,
    pendingCount: 2, blockers: [{ taskId: 'T009' }]
  });
  assert.deepEqual(JSON.parse(machine), {
    runId: 'r1', kind: 'needs_approval', exit: 10, status: 'running',
    contractRevision: 3, pending: 2, contractBlockedTaskIds: ['T009']
  });

  assert.equal(pendingItemPath('/runs', 'r'), join('/runs', 'r', 'pending.json'));
  assert.equal(blockersPath('/runs', 'r'), join('/runs', 'r', 'blockers.json'));
  assert.equal(handoffPath('/runs', 'r'), join('/runs', 'r', 'handoff.json'));
});

test('pending and blockers files round-trip and tolerate malformed input', () => {
  const dir = scratch('agent-team-run-exit-files-');
  const pendingPath = join(dir, 'nested', 'pending.json');
  writePendingFileSync(pendingPath, { runId: 'r1', pending: [{ id: 'p1', kind: 'approval', taskId: null, agentId: 'worker:claude', subject: 'x', reason: 'y' }] });
  assert.equal(readPendingFileSync(pendingPath).pending.length, 1);
  assert.equal(readPendingFileSync(join(dir, 'missing.json')), undefined);

  writeFileSync(join(dir, 'garbage.json'), 'not json', 'utf8');
  assert.equal(readPendingFileSync(join(dir, 'garbage.json')), undefined);
  writeFileSync(join(dir, 'shape.json'), JSON.stringify({ runId: 7, pending: 'nope' }), 'utf8');
  assert.equal(readPendingFileSync(join(dir, 'shape.json')), undefined);
  writeFileSync(join(dir, 'number.json'), '5', 'utf8');
  assert.equal(readPendingFileSync(join(dir, 'number.json')), undefined);

  const blockersPathFile = join(dir, 'nested2', 'blockers.json');
  writeBlockersFileSync(blockersPathFile, [{ taskId: 'T001', title: 't', attempts: 1, reason: 'r' }]);
  assert.deepEqual(JSON.parse(readFileSync(blockersPathFile, 'utf8')).blockers.length, 1);
});

test('extractCommands collects command strings from backend input shapes', () => {
  assert.deepEqual(extractCommands({ command: 'pnpm add zod' }), ['pnpm add zod']);
  assert.deepEqual(extractCommands({ cmd: 'make test' }), ['make test']);
  assert.deepEqual(extractCommands({ script: 'go test ./...' }), ['go test ./...']);
  assert.deepEqual(extractCommands({ command: ['docker', 'compose', 'up'] }), ['docker compose up']);
  assert.deepEqual(extractCommands('raw string'), ['raw string']);
  assert.deepEqual(extractCommands(['a', { command: 'b' }]), ['a', 'b']);
  assert.deepEqual(extractCommands({ unrelated: true }), []);
  assert.deepEqual(extractCommands(null), []);
});

test('partitionGrants splits approve, deny, and unresolved decisions', () => {
  const pending = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
  const split = partitionGrants(pending, { p1: 'approve', p2: 'deny' });
  assert.deepEqual(split.approved.map((item) => item.id), ['p1']);
  assert.deepEqual(split.denied.map((item) => item.id), ['p2']);
  assert.deepEqual(split.unresolved.map((item) => item.id), ['p3']);
});

test('ApprovalCollector denies with guidance, persists items, and drives eager aborts', async () => {
  const dir = scratch('agent-team-collector-');
  const pendingPath = join(dir, 'pending.json');
  const existing = { runId: 'run-a', pending: [{ id: 'p7', kind: 'approval', taskId: null, agentId: 'w', subject: 'old', reason: 'r' }] };
  writePendingFileSync(pendingPath, existing);

  const aborts = [];
  const collector = new ApprovalCollector({
    runId: 'run-a', pendingPath, grantsPath: join(dir, 'grants.json'), debounceMs: 0, exitMode: 'eager',
    allowedPrefixes: [], onEagerAbort: () => aborts.push('a')
  });
  assert.equal(collector.pending.length, 1);
  assert.equal(collector.hasPending, true);

  const decision = await collector.requestApproval({
    backend: 'claude', role: 'worker', cwd: '/w', kind: 'command', tool: 'Bash',
    input: { command: 'pnpm add left-pad' }, allowSession: false
  });
  assert.equal(decision, 'deny');
  assert.equal(collector.pending.length, 2);
  assert.equal(collector.pending[1].id, 'p8');
  assert.equal(collector.pending[1].taskId, null);
  assert.deepEqual(collector.pending[1].commands, ['pnpm add left-pad']);
  assert.match(collector.pending[1].reason, /mechanically equivalent alternative/);
  assert.deepEqual(aborts, ['a']);

  const answers = await collector.requestUserInput({
    backend: 'codex', role: 'reviewer', cwd: '/w', taskId: 'T001',
    questions: [{ id: 'q1', question: 'Which format?' }]
  });
  assert.deepEqual(answers, {});
  assert.equal(collector.pending[2].kind, 'question');
  assert.equal(collector.pending[2].taskId, 'T001');
  assert.deepEqual(collector.pending[2].commands, undefined);
  assert.deepEqual(aborts, ['a', 'a']);

  const onDisk = JSON.parse(readFileSync(pendingPath, 'utf8'));
  assert.equal(onDisk.pending.length, 3);

  collector.dispose();
  const quiescent = new ApprovalCollector({
    runId: 'other-run', pendingPath, grantsPath: join(dir, 'grants.json'), debounceMs: 50, exitMode: 'quiescence',
    allowedPrefixes: [], onEagerAbort: () => aborts.push('never')
  });
  assert.equal(quiescent.pending.length, 0, 'items from another run are not carried over');
  await quiescent.requestApproval({
    backend: 'claude', role: 'worker', cwd: '/w', kind: 'tool', tool: 'WebFetch',
    input: 'https://example.test', allowSession: true, reason: 'custom reason'
  });
  assert.deepEqual(aborts.filter((entry) => entry === 'never'), []);
  assert.equal(quiescent.pending[0].reason, 'custom reason');
  quiescent.dispose();
});

test('agent log reads bounded tails inside the run directory only', async () => {
  const parent = scratch('agent-team-agent-log-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  mkdirSync(join(home.runsDir, 'r1', 'logs'), { recursive: true });
  const logPath = join(home.runsDir, 'r1', 'logs', 'agent.log');
  writeFileSync(logPath, Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n'), 'utf8');
  const db = new StateDatabase(home.stateDb);
  db.createRun({ id: 'r1', repoRoot: parent, goalFile: 'g', baseRef: 'HEAD', baseSha: 's', adapter: 'external' });
  db.startAgentExecution({ runId: 'r1', agentId: 'w1', role: 'worker', backend: 'claude', logPath });

  const tail = await readAgentLog(db, home.runsDir, 'r1', 'w1', 5, 64 * 1024);
  assert.equal(tail.lineCount, 5);
  assert.equal(tail.content.split('\n')[0], 'line-15');
  assert.equal(tail.truncated, true);

  const byteLimited = await readAgentLog(db, home.runsDir, 'r1', 'w1', 200, 20);
  assert.equal(byteLimited.truncated, true);
  assert.ok(byteLimited.byteCount <= 20);
  db.close();

  const emptyDb = new StateDatabase(join(scratch('agent-team-agent-log-empty-'), 'state.sqlite'));
  await assert.rejects(readAgentLog(emptyDb, home.runsDir, 'r1', 'missing', 10, 1024), /not recorded/);
  await assert.rejects(readAgentLog(emptyDb, home.runsDir, 'gone', 'w1', 10, 1024), /not recorded|does not exist|unavailable/);
  emptyDb.close();
});

test('agent log rejects paths outside the managed run directory and non-files', async () => {
  const parent = scratch('agent-team-agent-log-guard-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  mkdirSync(join(home.runsDir, 'r1'), { recursive: true });
  const outside = join(parent, 'outside.log');
  writeFileSync(outside, 'secret', 'utf8');
  const db = new StateDatabase(home.stateDb);
  db.createRun({ id: 'r1', repoRoot: parent, goalFile: 'g', baseRef: 'HEAD', baseSha: 's', adapter: 'external' });
  db.startAgentExecution({ runId: 'r1', agentId: 'w1', role: 'worker', backend: 'claude', logPath: outside });
  await assert.rejects(readAgentLog(db, home.runsDir, 'r1', 'w1', 10, 1024), /outside the managed run directory/);

  const directoryLog = join(home.runsDir, 'r1', 'dirlog');
  mkdirSync(directoryLog, { recursive: true });
  db.startAgentExecution({ runId: 'r1', agentId: 'w2', role: 'worker', backend: 'claude', logPath: directoryLog });
  await assert.rejects(readAgentLog(db, home.runsDir, 'r1', 'w2', 10, 1024), /is not a regular file/);

  db.startAgentExecution({ runId: 'r1', agentId: 'w3', role: 'worker', backend: 'claude', logPath: join(home.runsDir, 'r1', 'missing.log') });
  await assert.rejects(readAgentLog(db, home.runsDir, 'r1', 'w3', 10, 1024), /does not exist/);

  // realpath 通过之后 open 失败（权限拒绝）：按不可读分类。
  const lockedLog = join(home.runsDir, 'r1', 'locked.log');
  writeFileSync(lockedLog, 'secret\n', 'utf8');
  chmodSync(lockedLog, 0o000);
  db.startAgentExecution({ runId: 'r1', agentId: 'w4', role: 'worker', backend: 'claude', logPath: lockedLog });
  try {
    await assert.rejects(readAgentLog(db, home.runsDir, 'r1', 'w4', 10, 1024), /not readable/);
  } finally {
    chmodSync(lockedLog, 0o644);
  }
  db.close();
});

test('clean removes task and integration worktrees and branches, then cancels the run', async () => {
  const repoRoot = scratch('agent-team-clean-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);

  const parent = scratch('agent-team-clean-home-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  mkdirSync(join(home.worktreesDir, 'r1'), { recursive: true });
  const worktreePath = join(home.worktreesDir, 'r1', 'integration');
  const integrationBranch = 'agent-team/r1/integration';
  await git(repoRoot, ['worktree', 'add', worktreePath, '-b', integrationBranch, 'HEAD']);

  const db = new StateDatabase(home.stateDb);
  let result;
  try {
    db.createRun({ id: 'r1', repoRoot, goalFile: 'g', baseRef: 'HEAD', baseSha: 'base', adapter: 'external' });
    db.insertTask('r1', {
      id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['**'], blockedPaths: [],
      acceptance: ['a'], verificationCommands: []
    });
    db.updateTask('r1', 'T001', { branch: integrationBranch, worktree: worktreePath });
    db.updateRun('r1', { integrationBranch, integrationWorktree: worktreePath });
    result = await cleanRunArtifacts(db, home, 'r1');
    assert.deepEqual(result.removedWorktrees, [worktreePath]);
    assert.deepEqual(result.removedBranches, [integrationBranch]);
    const run = db.getRun('r1');
    assert.equal(run.status, 'cancelled');
    assert.match(run.error, /Cleaned by agent-team clean/);
    const listed = await git(repoRoot, ['worktree', 'list', '--porcelain'], true);
    assert.doesNotMatch(listed.stdout, /agent-team\/r1\/integration/);

    const second = await cleanRunArtifacts(db, home, 'r1');
    assert.deepEqual(second.removedWorktrees, []);
    assert.deepEqual(second.removedBranches, []);
    assert.equal(db.getRun('r1').status, 'cancelled');
  } finally {
    db.close();
  }
});

test('clean takes the run lock: refuses live runners, takes over crash residue', async () => {
  const repoRoot = scratch('agent-team-clean-lock-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);

  const parent = scratch('agent-team-clean-lock-home-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  const db = new StateDatabase(home.stateDb);
  try {
    db.createRun({ id: 'r1', repoRoot, goalFile: 'g', baseRef: 'HEAD', baseSha: 'base', adapter: 'external' });
    db.insertTask('r1', {
      id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['**'], blockedPaths: [],
      acceptance: ['a'], verificationCommands: []
    });
    db.updateRun('r1', { status: 'running' });

    // 活跃 runner 持有锁：clean 不得删除其 worktree/分支。
    mkdirSync(join(home.runsDir, 'r1', 'lock'), { recursive: true });
    writeFileSync(join(home.runsDir, 'r1', 'lock', 'pid'), String(process.pid), 'utf8');
    await assert.rejects(cleanRunArtifacts(db, home, 'r1'), /already executing/);
    assert.equal(db.getRun('r1').status, 'running', 'a live run must not be cancelled');

    // 崩溃残留（pid 不存活）：接管锁后正常清理。
    writeFileSync(join(home.runsDir, 'r1', 'lock', 'pid'), '999999', 'utf8');
    const result = await cleanRunArtifacts(db, home, 'r1');
    assert.deepEqual(result.removedWorktrees, []);
    assert.deepEqual(result.removedBranches, []);
    assert.equal(db.getRun('r1').status, 'cancelled');
  } finally {
    db.close();
  }
});

function unitsContract(repoRoot) {
  return {
    version: 1, project: { id: 'bare-project', repoRoot, baseRef: 'HEAD' },
    tasks: [{ id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] }]
  };
}

test('contract revision requires a materialized external contract', async () => {
  const parent = scratch('agent-team-revision-bare-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  const registry = new ProjectRegistry(home.stateDb);
  const db = new StateDatabase(home.stateDb);
  try {
    registry.registerProject({
      gitCommonDir: join(parent, '.git'), repoRoot: parent, displayName: 'bare',
      gitIdentity: { root: parent },
      id: 'bare-project',
      policy: {
        baseRef: 'HEAD', verificationAllowedCommandPrefixes: ['pnpm test'],
        agentProfileMapping: { defaultAgent: 'default-claude', agents: { 'default-claude': { backend: 'claude' }, 'default-codex': { backend: 'codex' } }, roles: { reviewer: 'default-codex' } },
        backendPolicy: {}
      }
    });
    const bareDb = join(parent, 'bare.sqlite');
    const bare = new StateDatabase(bareDb);
    bare.createRun({ id: 'no-contract', repoRoot: parent, goalFile: 'g', baseRef: 'HEAD', baseSha: 's', adapter: 'external' });
    assert.throws(() => applyContractRevision({ db: bare, projectRegistry: registry, home, runId: 'no-contract', contract: unitsContract(parent) }), /no external execution contract/);
    bare.close();

    const withContract = new StateDatabase(join(parent, 'with.sqlite'));
    withContract.createRun({
      id: 'contract-only', repoRoot: parent, goalFile: 'g', baseRef: 'HEAD', baseSha: 's', adapter: 'external',
      executionContractJson: JSON.stringify(unitsContract(parent))
    });
    assert.throws(() => applyContractRevision({ db: withContract, projectRegistry: registry, home, runId: 'contract-only', contract: unitsContract(parent) }), /no external execution contract/);
    withContract.close();
  } finally {
    db.close();
  }
});

test('contract revision rejects protected changes and accepts a valid revision', async () => {
  const repoRoot = scratch('agent-team-revision-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const parent = scratch('agent-team-revision-home-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  const registry = new ProjectRegistry(home.stateDb);
  const db = new StateDatabase(home.stateDb);
  try {
    const project = registry.registerProject({
      gitCommonDir: join(repoRoot, '.git'),
      repoRoot,
      displayName: 'rev',
      gitIdentity: { root: repoRoot },
      id: 'rev-project',
      policy: {
        baseRef: 'HEAD',
        verificationAllowedCommandPrefixes: ['pnpm test'],
        agentProfileMapping: { defaultAgent: 'default-claude', agents: { 'default-claude': { backend: 'claude' }, 'default-codex': { backend: 'codex' } }, roles: { reviewer: 'default-codex' } },
        backendPolicy: {}
      }
    });
    const policy = registry.getProjectPolicy(project.id);
    const config = runnerConfigFromProjectPolicy(policy, project, home);
      const contract = {
      version: 1,
      project: { id: 'rev-project', repoRoot, baseRef: 'HEAD' },
      tasks: [
        { id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['server/**'], blockedPaths: [], acceptance: ['first'], verificationCommands: [] },
        { id: 'T002', title: 'u', description: 'e', dependsOn: ['T001'], allowedPaths: ['docs/**'], blockedPaths: [], acceptance: ['docs'], verificationCommands: [] },
        { id: 'T004', title: 'v', description: 'f', dependsOn: [], allowedPaths: ['web/**'], blockedPaths: [], acceptance: ['web'], verificationCommands: [] }
      ]
    };
    const runId = await createExecutionRun({ config, db, contract, projectPolicyRevisionId: policy.id });
    db.updateTask(runId, 'T001', { status: 'blocked_on_contract', lastError: 'need more scope' });

    const clone = (value) => JSON.parse(JSON.stringify(value));
    const revise = (mutate) => applyContractRevision({
      db, projectRegistry: registry, home, runId, contract: mutate(clone(contract))
    });

    assert.throws(() => revise((c) => { c.project.baseRef = 'other'; return c; }), /cannot change the run project or base ref/);
    assert.throws(() => revise((c) => { c.tasks.pop(); return c; }), /cannot remove task T004/);
    assert.throws(() => revise((c) => { c.tasks[0].verificationCommands = ['rm -rf /']; return c; }), /not allowlisted/);
    assert.throws(() => revise((c) => { c.tasks[2].acceptance = ['web changed']; return c; }), /can only change blocked tasks or their downstream tasks: T004/);
    assert.throws(() => revise((c) => {
      c.tasks.push({ id: 'T009', title: 'n', description: 'd', dependsOn: [], allowedPaths: ['ios/**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] });
      return c;
    }), /must depend on a contract-blocked task/);

    db.updateTask(runId, 'T001', { status: 'approved' });
    assert.throws(() => revise((c) => { c.tasks[0].acceptance = ['second']; return c; }), /cannot change approved task T001/);
    assert.throws(() => revise((c) => c), /has no blocked_on_contract task/);
    db.updateTask(runId, 'T001', { status: 'blocked_on_contract' });
    db.updateTask(runId, 'T002', { status: 'approved' });

    // Downstream of a blocked task is affected: approved downstream keeps its spec, and a dependent new task is inserted.
    const result = revise((c) => {
      c.tasks[0].acceptance = ['second'];
      c.tasks.push({ id: 'T003', title: 'n', description: 'd', dependsOn: ['T001'], allowedPaths: ['android/**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] });
      return c;
    });
    assert.equal(result.revision, 2);
    assert.deepEqual(result.affectedTaskIds, ['T001', 'T002', 'T003']);
    assert.deepEqual(db.listTasks(runId).map((task) => `${task.taskId}:${task.status}`), ['T001:pending', 'T002:approved', 'T003:pending', 'T004:pending']);

    // A run without a pinned policy revision falls back to the current project policy.
    const fallbackRunId = await createExecutionRun({ config, db, contract: clone(contract) });
    db.updateTask(fallbackRunId, 'T001', { status: 'blocked_on_contract' });
    const fallbackContract = clone(contract);
    fallbackContract.tasks[0].acceptance = ['fallback'];
    const fallback = applyContractRevision({
      db, projectRegistry: registry, home, runId: fallbackRunId, contract: fallbackContract
    });
    assert.equal(fallback.revision, 2);
    assert.deepEqual(fallback.affectedTaskIds, ['T001', 'T002']);
    const task = db.getTask(runId, 'T001');
    assert.equal(task.status, 'pending');
    assert.equal(db.getRun(runId).contractRevision, 2);
    const stored = JSON.parse(readFileSync(join(home.runsDir, runId, 'contract.json'), 'utf8'));
    assert.deepEqual(stored.tasks[0].acceptance, ['second']);
  } finally {
    db.close();
  }
});

async function revisionFixture(prefix) {
  const repoRoot = scratch(`${prefix}-repo-`);
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const parent = scratch(`${prefix}-home-`);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  const registry = new ProjectRegistry(home.stateDb);
  const project = registry.registerProject({
    gitCommonDir: join(repoRoot, '.git'),
    repoRoot,
    displayName: 'rev',
    gitIdentity: { root: repoRoot },
    id: `${prefix}-project`,
    policy: {
      baseRef: 'HEAD',
      verificationAllowedCommandPrefixes: ['pnpm test'],
      agentProfileMapping: { defaultAgent: 'default-claude', agents: { 'default-claude': { backend: 'claude' }, 'default-codex': { backend: 'codex' } }, roles: { reviewer: 'default-codex' } },
      backendPolicy: {}
    }
  });
  const policy = registry.getProjectPolicy(project.id);
  const config = runnerConfigFromProjectPolicy(policy, project, home);
  const db = new StateDatabase(home.stateDb);
  const contract = {
    version: 1,
    project: { id: project.id, repoRoot, baseRef: 'HEAD' },
    tasks: [
      { id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['server/**'], blockedPaths: [], acceptance: ['first'], verificationCommands: [] },
      { id: 'T002', title: 'u', description: 'e', dependsOn: ['T001'], allowedPaths: ['docs/**'], blockedPaths: [], acceptance: ['docs'], verificationCommands: [] }
    ]
  };
  const runId = await createExecutionRun({ config, db, contract, projectPolicyRevisionId: policy.id });
  db.updateTask(runId, 'T001', { status: 'blocked_on_contract', lastError: 'need more scope' });
  return { home, registry, db, contract, runId };
}

test('contract revision updates downstream tasks whose dependency was removed', async () => {
  const { home, registry, db, contract, runId } = await revisionFixture('agent-team-rev-unlink');
  try {
    // 合法修订：T002 不再依赖 blocked 的 T001，同时其内容按新契约变化。
    const revised = JSON.parse(JSON.stringify(contract));
    revised.tasks[1].dependsOn = [];
    revised.tasks[1].acceptance = ['rewritten'];
    const result = applyContractRevision({ db, projectRegistry: registry, home, runId, contract: revised });

    assert.deepEqual(result.affectedTaskIds, ['T001', 'T002']);
    const rewritten = JSON.parse(db.getTask(runId, 'T002').specJson);
    assert.deepEqual(rewritten.acceptance, ['rewritten'], 'spec_json must follow the revised contract');
    assert.equal(rewritten.dependsOn.length, 0);
    assert.equal(db.getTask(runId, 'T002').status, 'pending');
    const markdown = readFileSync(join(home.runsDir, runId, 'tasks', 'T002.md'), 'utf8');
    assert.match(markdown, /rewritten/, 'task markdown must follow the revised contract');
    const stored = JSON.parse(readFileSync(join(home.runsDir, runId, 'contract.json'), 'utf8'));
    assert.deepEqual(stored.tasks[1].dependsOn, []);
  } finally {
    db.close();
  }
});

test('contract revision is atomic: a mid-flight failure leaves DB and files untouched', async () => {
  const { home, registry, db, contract, runId } = await revisionFixture('agent-team-rev-atomic');
  try {
    const exploding = Object.create(db);
    exploding.replaceTaskSpec = () => { throw new Error('boom: staged failure'); };

    const revised = JSON.parse(JSON.stringify(contract));
    revised.tasks[0].acceptance = ['changed'];
    revised.tasks[1].acceptance = ['changed too'];
    // 新增任务：回滚必须连带删除新暂存的产物（previous === null 分支）。
    revised.tasks.push({
      id: 'T003', title: 'n', description: 'new', dependsOn: ['T001'], allowedPaths: ['extra/**'],
      blockedPaths: [], acceptance: ['new'], verificationCommands: []
    });

    assert.throws(
      () => applyContractRevision({ db: exploding, projectRegistry: registry, home, runId, contract: revised }),
      /boom: staged failure/
    );

    // DB 未留下半套状态：spec 与修订号保持原值。
    assert.deepEqual(JSON.parse(db.getTask(runId, 'T001').specJson).acceptance, ['first']);
    assert.deepEqual(JSON.parse(db.getTask(runId, 'T002').specJson).acceptance, ['docs']);
    assert.equal(db.getRun(runId).contractRevision, 1);
    assert.throws(() => db.getTask(runId, 'T003'), /Task not found/);

    // 磁盘未留下半套状态：contract.json 与任务 Markdown 仍是旧版，且无临时文件残留。
    const stored = JSON.parse(readFileSync(join(home.runsDir, runId, 'contract.json'), 'utf8'));
    assert.deepEqual(stored.tasks[0].acceptance, ['first']);
    const runDir = join(home.runsDir, runId);
    const leftovers = [];
    const visit = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(dir, entry.name));
        else if (/\.tmp-\d+$/.test(entry.name)) leftovers.push(entry.name);
      }
    };
    visit(runDir);
    assert.deepEqual(leftovers, []);
  } finally {
    db.close();
  }
});

test('withRunId annotates failures so outer controllers can locate the run', () => {
  const cause = new Error('integration blew up');
  const annotated = withRunId(cause, 'run-42');
  assert.match(annotated.message, /^Run run-42: integration blew up$/);
  assert.equal(annotated.runId, 'run-42');
  assert.equal(annotated.cause, cause);
  assert.equal(withRunId('plain string failure', 'run-7').message, 'Run run-7: plain string failure');
});

test('handoff reads and writes completed runs only', () => {
  const parent = scratch('agent-team-handoff-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  const db = new StateDatabase(home.stateDb);
  try {
    db.createRun({ id: 'h1', repoRoot: parent, goalFile: 'g', baseRef: 'HEAD', baseSha: 'base', adapter: 'external' });
    db.insertTask('h1', { id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] });

    writeHandoff(db, home.runsDir, 'h1');
    assert.equal(existsSync(handoffPath(home.runsDir, 'h1')), false);
    assert.equal(readHandoff(home.runsDir, 'h1'), undefined);

    db.updateRun('h1', { status: 'done' });
    writeHandoff(db, home.runsDir, 'h1');
    const handoff = readHandoff(home.runsDir, 'h1');
    assert.equal(handoff.run.status, 'done');
    assert.equal(handoff.contract, null);
    assert.deepEqual(handoff.tasks[0].status, 'pending');
  } finally {
    db.close();
  }
});

test('parseRunCommandArgs validates run options', () => {
  assert.deepEqual(parseRunCommandArgs(['c.json']), { contractPath: 'c.json' });
  assert.deepEqual(parseRunCommandArgs(['--contract', 'c.json', '--run-id', 'r1', '--grant', 'g.json']), {
    contractPath: 'c.json', runId: 'r1', grantPath: 'g.json'
  });
  const full = parseRunCommandArgs([
    '--contract', 'c.json', '--debounce-ms', '25', '--max-parallel', '2', '--exit-mode', 'eager', '--home', '/tmp/h'
  ]);
  assert.deepEqual(full, {
    contractPath: 'c.json', debounceMs: 25, maxParallel: 2, exitMode: 'eager', homePath: '/tmp/h'
  });
  assert.throws(() => parseRunCommandArgs([]), /requires --contract/);
  assert.throws(() => parseRunCommandArgs(['--contract']), /requires a value/);
  assert.throws(() => parseRunCommandArgs(['c.json', '--nope']), /Unknown run option/);
  assert.throws(() => parseRunCommandArgs(['--exit-mode', 'sometimes']), /must be "eager" or "quiescence"/);
  assert.throws(() => parseRunCommandArgs(['--debounce-ms', '-5']), /non-negative integer/);
  assert.throws(() => parseRunCommandArgs(['--debounce-ms', 'soon']), /non-negative integer/);
  assert.throws(() => parseRunCommandArgs(['--max-parallel', '0']), /positive integer/);
  assert.throws(() => parseRunCommandArgs(['--max-parallel', 'many']), /positive integer/);
});

test('readGrantDecisions validates decision payloads', () => {
  const dir = scratch('agent-team-grants-');
  const path = join(dir, 'decisions.json');
  writeFileSync(path, JSON.stringify({ p1: 'approve', p2: 'deny' }), 'utf8');
  assert.deepEqual(readGrantDecisions(path), { p1: 'approve', p2: 'deny' });
  writeFileSync(path, JSON.stringify(['p1']), 'utf8');
  assert.throws(() => readGrantDecisions(path), /must be a JSON object/);
  writeFileSync(path, JSON.stringify({ p1: 'maybe' }), 'utf8');
  assert.throws(() => readGrantDecisions(path), /must be "approve" or "deny"/);
});

test('agent log guards symlinks, empty files, CRLF, and non-regular targets', async () => {
  const parent = scratch('agent-team-agent-log-edges-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  mkdirSync(join(home.runsDir, 'r1', 'logs'), { recursive: true });
  const db = new StateDatabase(home.stateDb);
  db.createRun({ id: 'r1', repoRoot: parent, goalFile: 'g', baseRef: 'HEAD', baseSha: 's', adapter: 'external' });

  const outside = join(parent, 'outside.log');
  writeFileSync(outside, 'secret', 'utf8');
  const symlinked = join(home.runsDir, 'r1', 'logs', 'link.log');
  symlinkSync(outside, symlinked);
  db.startAgentExecution({ runId: 'r1', agentId: 'link', role: 'worker', backend: 'claude', logPath: symlinked });
  await assert.rejects(readAgentLog(db, home.runsDir, 'r1', 'link', 10, 1024), /outside the managed run directory/);

  const emptyLog = join(home.runsDir, 'r1', 'logs', 'empty.log');
  writeFileSync(emptyLog, '', 'utf8');
  db.startAgentExecution({ runId: 'r1', agentId: 'empty', role: 'worker', backend: 'claude', logPath: emptyLog });
  const emptyTail = await readAgentLog(db, home.runsDir, 'r1', 'empty', 10, 1024);
  assert.deepEqual([emptyTail.lineCount, emptyTail.content, emptyTail.truncated], [0, '', false]);

  const crlfLog = join(home.runsDir, 'r1', 'logs', 'crlf.log');
  writeFileSync(crlfLog, 'one\r\ntwo\r\n', 'utf8');
  db.startAgentExecution({ runId: 'r1', agentId: 'crlf', role: 'worker', backend: 'claude', logPath: crlfLog });
  const crlfTail = await readAgentLog(db, home.runsDir, 'r1', 'crlf', 10, 1024);
  assert.equal(crlfTail.content, 'one\ntwo');

  const unterminated = join(home.runsDir, 'r1', 'logs', 'unterminated.log');
  writeFileSync(unterminated, 'tail-line', 'utf8');
  db.startAgentExecution({ runId: 'r1', agentId: 'unterminated', role: 'worker', backend: 'claude', logPath: unterminated });
  assert.equal((await readAgentLog(db, home.runsDir, 'r1', 'unterminated', 10, 1024)).content, 'tail-line');

  db.close();

  const errorArms = [
    [agentLogReadError('r', 'a', { code: 'ENOENT' }).message, /does not exist/],
    [agentLogReadError('r', 'a', { code: 'EACCES' }).message, /not readable/],
    [agentLogReadError('r', 'a', 'plain failure').message, /unavailable: r\/a$/]
  ];
  for (const [message, pattern] of errorArms) assert.match(message, pattern);

});

test('ApprovalCollector tolerates non-numeric ids, null question tasks, and circular inputs', async () => {
  const dir = scratch('agent-team-collector-edges-');
  const pendingPath = join(dir, 'pending.json');
  writePendingFileSync(pendingPath, {
    runId: 'r1',
    pending: [{ id: 'legacy-item', kind: 'question', taskId: null, agentId: 'w', subject: 'old', reason: 'r' }]
  });
  const collector = new ApprovalCollector({
    runId: 'r1', pendingPath, grantsPath: join(dir, 'grants.json'), debounceMs: 50, exitMode: 'quiescence',
    allowedPrefixes: [], onEagerAbort: () => {}
  });
  assert.equal(collector.pending[0].id, 'legacy-item');

  const circular = {};
  circular.self = circular;
  collector.requestApproval({
    backend: 'claude', role: 'worker', cwd: '/w', kind: 'tool', tool: 'Loop',
    input: circular, allowSession: false
  });
  assert.match(collector.pending[1].subject, /Loop: unknown input/);

  const answers = await collector.requestUserInput({
    backend: 'codex', role: 'worker', cwd: '/w', questions: [{ id: 'q', question: 'Proceed?' }]
  });
  assert.deepEqual(answers, {});
  assert.equal(collector.pending[2].taskId, null);
  collector.flush();
  assert.equal(readPendingFileSync(pendingPath).pending.length, 3);
});

test('agent log maps unknown errno codes', () => {
  assert.match(agentLogReadError('r', 'a', { code: 'EIO' }).message, /unavailable: r\/a \(EIO\)/);
});

test('command matchers accept the platform default and the lock rethrows real errors', () => {
  // 缺省 platform 参数的调用形态（审批收集器即如此使用）。
  assert.equal(isAllowlistedCommand('npm test', ['npm test', 'go test']), true);
  assert.equal(isAllowlistedCommand('cargo build', ['npm test', 'go test']), false);
  assert.equal(isExactAllowlistEntry('npm test', ['npm test -- --filter api']), false);
  assert.equal(isExactAllowlistEntry('go test ./...', ['npm test', 'go test ./...']), true);

  const parent = scratch('agent-team-lock-eisdir-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  // lock 目录不可写：wx 创建失败且不是 EEXIST，必须原样抛出而不是被当成锁竞争吞掉。
  const lockDir = join(home.runsDir, 'r1', 'lock');
  mkdirSync(lockDir, { recursive: true });
  chmodSync(lockDir, 0o500);
  try {
    assert.throws(() => acquireRunLock(home, 'r1'), /EACCES|permission denied/i);
  } finally {
    chmodSync(lockDir, 0o755);
  }
});

test('run lock treats unreadable pid files as crash residue and takes over', () => {
  const parent = scratch('agent-team-lock-garbage-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  mkdirSync(join(home.runsDir, 'r1', 'lock'), { recursive: true });
  writeFileSync(join(home.runsDir, 'r1', 'lock', 'pid'), 'not-a-pid', 'utf8');
  // 非数字 pid 读不出来（undefined ≠ 存活进程）：按残留接管，锁最终被本进程持有。
  acquireRunLock(home, 'r1');
  assert.equal(readFileSync(join(home.runsDir, 'r1', 'lock', 'pid'), 'utf8'), String(process.pid));
  releaseRunLock(home, 'r1');
});

test('grants state file rejects malformed content and quarantines it', () => {
  const dir = scratch('agent-team-grants-validate-');
  const valid = join(dir, 'valid.json');
  writeGrantsFileSync(valid, { runId: 'r1', grants: [{ tool: 'webfetch', input: { pattern: 'https://x' } }] });
  assert.deepEqual(readGrantsFileSync(valid), { runId: 'r1', grants: [{ tool: 'webfetch', input: { pattern: 'https://x' } }] });

  const malformed = [
    JSON.stringify(['not', 'an', 'object']),
    JSON.stringify({ grants: [] }),
    JSON.stringify({ runId: 'r1', grants: 'nope' }),
    JSON.stringify({ runId: 'r1', grants: ['not-an-object'] }),
    JSON.stringify({ runId: 'r1', grants: [{ input: {} }] }),
    JSON.stringify({ runId: 'r1', grants: [['odd']] })
  ];
  for (const [index, body] of malformed.entries()) {
    const name = `malformed-${index}.json`;
    writeFileSync(join(dir, name), body, 'utf8');
    assert.equal(readGrantsFileSync(join(dir, name)), undefined, body);
    // 损坏文件被隔离备份，原路径按不存在处理。
    assert.ok(readdirSync(dir).some((entry) => entry.startsWith(`${name}.corrupt-`)), body);
    assert.equal(existsSync(join(dir, name)), false, body);
  }
  assert.equal(readGrantsFileSync(join(dir, 'absent.json')), undefined);
});

test('ApprovalCollector records undefined tool input as unknown', async () => {
  const dir = scratch('agent-team-collector-undefined-');
  const collector = new ApprovalCollector({
    runId: 'r1', pendingPath: join(dir, 'pending.json'), grantsPath: join(dir, 'grants.json'), debounceMs: 0,
    exitMode: 'eager', allowedPrefixes: ['pnpm test'], onEagerAbort: () => {}
  });
  const allowlisted = await collector.requestApproval({
    backend: 'claude', role: 'worker', cwd: '/w', kind: 'command', tool: 'Bash',
    input: { command: 'pnpm test' }, allowSession: false
  });
  assert.equal(allowlisted, 'once');
  assert.equal(collector.pending.length, 0);
  collector.requestApproval({
    backend: 'claude', role: 'worker', cwd: '/w', kind: 'tool', tool: 'Unknown',
    input: undefined, allowSession: false
  });
  assert.match(collector.pending[0].subject, /Unknown: unknown input/);
  collector.dispose();
});

test('ApprovalCollector re-checks dangerous arguments even when the prefix is allowlisted', async () => {
  const dir = scratch('agent-team-collector-unsafe-');
  const collector = new ApprovalCollector({
    runId: 'r1', pendingPath: join(dir, 'pending.json'), grantsPath: join(dir, 'grants.json'), debounceMs: 0,
    exitMode: 'quiescence', allowedPrefixes: ['git status', 'npm run build'], onEagerAbort: () => {}
  });
  const requests = [
    // 批准过 `git status` 不等于批准 `git status --ext-diff`（helper 执行）
    { command: 'git status --ext-diff' },
    // 批准过 `npm run build` 不等于批准携带路径覆盖的变体
    { command: 'npm run build --prefix /elsewhere' }
  ];
  for (const input of requests) {
    const decision = await collector.requestApproval({
      backend: 'claude', role: 'worker', cwd: '/w', kind: 'command', tool: 'Bash',
      input, allowSession: false
    });
    assert.equal(decision, 'deny', input.command);
  }
  assert.equal(collector.pending.length, requests.length);

  // 前缀命中且无危险参数的命令仍然直接放行（grant 沉淀后的重放路径）。
  const safe = await collector.requestApproval({
    backend: 'claude', role: 'worker', cwd: '/w', kind: 'command', tool: 'Bash',
    input: { command: 'git status --porcelain' }, allowSession: false
  });
  assert.equal(safe, 'once');
  assert.equal(collector.pending.length, requests.length);
  collector.dispose();
});

test('ApprovalCollector auto-approves granted non-command permissions on replay', async () => {
  const dir = scratch('agent-team-collector-grants-');
  const pendingPath = join(dir, 'pending.json');
  const grantsPath = join(dir, 'grants.json');
  // 既有授权缺 input 字段：匹配必须把 undefined 归一为 null，而不是崩溃或误判。
  writeGrantsFileSync(grantsPath, { runId: 'other-run', grants: [{ tool: 'untouched' }] });

  // 第一轮：非命令权限（网络、外部目录）没有 allowlist 载体 → deny 并记录。
  const first = new ApprovalCollector({
    runId: 'r1', pendingPath, grantsPath, debounceMs: 0, exitMode: 'quiescence',
    allowedPrefixes: [], onEagerAbort: () => {}
  });
  assert.equal(await first.requestApproval({
    backend: 'opencode', role: 'worker', cwd: '/w', kind: 'network', tool: 'webfetch',
    input: { pattern: 'https://example.test' }, allowSession: false
  }), 'deny');
  assert.equal(first.pending.length, 1);
  assert.equal(first.pending[0].tool, 'webfetch');
  first.dispose();

  // 外层批准沉淀为 run 内授权：重放对 tool+input 精确匹配的请求直接放行。
  writeGrantsFileSync(grantsPath, {
    runId: 'r1',
    grants: [{ tool: 'webfetch', input: { pattern: 'https://example.test' } }]
  });
  const second = new ApprovalCollector({
    runId: 'r1', pendingPath, grantsPath, debounceMs: 0, exitMode: 'quiescence',
    allowedPrefixes: [], onEagerAbort: () => {}
  });
  assert.equal(await second.requestApproval({
    backend: 'opencode', role: 'worker', cwd: '/w', kind: 'network', tool: 'webfetch',
    input: { pattern: 'https://example.test' }, allowSession: false
  }), 'once');
  // 同 tool 但 input 不同（或 runId 不同）不匹配。
  assert.equal(await second.requestApproval({
    backend: 'opencode', role: 'worker', cwd: '/w', kind: 'network', tool: 'webfetch',
    input: { pattern: 'https://other.test' }, allowSession: false
  }), 'deny');
  // 沉淀过的授权本身没有 input：无 input 的同工具请求凭归一化 null 匹配。
  writeGrantsFileSync(grantsPath, { runId: 'r1', grants: [{ tool: 'bare-tool' }] });
  const third = new ApprovalCollector({
    runId: 'r1', pendingPath, grantsPath, debounceMs: 0, exitMode: 'quiescence',
    allowedPrefixes: [], onEagerAbort: () => {}
  });
  assert.equal(await third.requestApproval({
    backend: 'opencode', role: 'worker', cwd: '/w', kind: 'tool', tool: 'bare-tool',
    input: undefined, allowSession: false
  }), 'once');
  third.dispose();
  second.dispose();
});

test('default allowlist does not auto-approve arbitrary npm scripts or pass-through arguments', async () => {
  const dir = scratch('agent-team-collector-npm-defaults-');
  const collector = new ApprovalCollector({
    runId: 'r1', pendingPath: join(dir, 'pending.json'), grantsPath: join(dir, 'grants.json'),
    debounceMs: 0, exitMode: 'quiescence',
    allowedPrefixes: DEFAULT_CONFIG.verification.allowedCommandPrefixes, onEagerAbort: () => {}
  });
  // 任意 npm script 不再被 `npm run` 盲目前缀放行。
  assert.equal(await collector.requestApproval({
    backend: 'claude', role: 'worker', cwd: '/w', kind: 'command', tool: 'Bash',
    input: { command: 'npm run deploy' }, allowSession: false
  }), 'deny');
  // `npm test -- -u`（快照写入等透传参数）必须走审批。
  assert.equal(await collector.requestApproval({
    backend: 'claude', role: 'worker', cwd: '/w', kind: 'command', tool: 'Bash',
    input: { command: 'npm test -- -u' }, allowSession: false
  }), 'deny');
  // 无透传参数的标准测试命令仍直接放行。
  assert.equal(await collector.requestApproval({
    backend: 'claude', role: 'worker', cwd: '/w', kind: 'command', tool: 'Bash',
    input: { command: 'npm test' }, allowSession: false
  }), 'once');
  collector.dispose();
});
