import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../src/core/git.ts';
import { StateDatabase } from '../src/core/db.ts';
import { assertHomeOutsideProcessRepo, resolveAgentTeamHome, ensureAgentTeamHome } from '../src/core/home.ts';
import { ProjectRegistry } from '../src/core/project-registry.ts';
import { runnerConfigFromProjectPolicy } from '../src/core/project-runtime.ts';
import { snapshotAgents } from '../src/agent/registry.ts';
import { killProcessTree } from '../src/agent/process-tree.ts';
import { writeHandoff } from '../src/core/handoff.ts';
import { executeRunCommand } from '../src/core/run-execute.ts';
import { blockersPath, classifyRunExit, contractBlockers, pendingItemPath, readPendingFileSync, writePendingFileSync } from '../src/core/run-exit.ts';

function runRecord(status) {
  return {
    id: 'r1', repoRoot: '/repo', goalFile: 'g', baseRef: 'HEAD', baseSha: 's', projectId: 'p',
    projectPolicyRevisionId: 'p:r1', executionContractJson: null, contractRevision: 1, adapter: 'external',
    status, manifestJson: null, rolesJson: null, integrationBranch: null, integrationWorktree: null,
    integrationCommit: null, error: null, createdAt: '', updatedAt: '', finishedAt: null
  };
}

function taskRecord(overrides = {}) {
  return {
    runId: 'r1', taskId: 'T001', title: 't', specJson: '{}', resolvedSkillsJson: '[]', status: 'pending',
    phase: null, branch: null, worktree: null, startSha: null, commitSha: null, attempts: 1, reviewCycles: 0,
    lastError: null, contractBlockJson: null, reviewJson: null, createdAt: '', updatedAt: '', finishedAt: null,
    ...overrides
  };
}

function approvalItem(overrides = {}) {
  return {
    id: 'p1', kind: 'approval', taskId: null, agentId: 'worker:claude', subject: 'Bash', reason: 'r', ...overrides
  };
}

test('classifyRunExit surfaces pending questions before task-level contract blocks', () => {
  const blocked = [taskRecord({ status: 'blocked_on_contract' })];
  // 提问优先：即便同时存在 blocked_on_contract，外层也要先从 pending.json 读到问题。
  assert.deepEqual(
    classifyRunExit({ run: runRecord('needs_attention'), tasks: blocked, pending: [questionItem()], interrupted: false }),
    { code: 10, kind: 'needs_approval' }
  );
  // 无提问时任务级契约阻塞仍是 exit 11。
  assert.deepEqual(
    classifyRunExit({ run: runRecord('needs_attention'), tasks: blocked, pending: [approvalItem()], interrupted: false }),
    { code: 11, kind: 'contract_blocked' }
  );
  assert.deepEqual(
    classifyRunExit({ run: runRecord('needs_attention'), tasks: [], pending: [approvalItem()], interrupted: false }),
    { code: 10, kind: 'needs_approval' }
  );
  assert.deepEqual(
    classifyRunExit({ run: runRecord('needs_attention'), tasks: [], pending: [], interrupted: false }),
    { code: 1, kind: 'failed' }
  );
});

function questionItem() {
  return {
    id: 'p2', kind: 'question', taskId: 'T001', agentId: 'worker:claude', subject: 'Which shape?', reason: 'r',
    questions: [{ id: 'q1', question: 'Which shape?' }]
  };
}

test('readPendingFileSync deep-validates every pending item and quarantines forged files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-review4-pending-'));
  const path = join(directory, 'pending.json');
  const base = approvalItem();

  const invalidItems = [
    42,
    { ...base, id: '' },
    { ...base, kind: 'grant' },
    { ...base, taskId: 7 },
    { ...base, reason: undefined, subject: undefined },
    { ...base, tool: 9 },
    { ...base, commands: ['ok', 5] },
    { ...base, questions: 'nope' },
    { ...base, questions: [{ id: 'a' }] },
    { ...base, questions: [42] },
    { ...base, questions: [{ id: 1, question: 'x' }] }
  ];
  for (const [index, item] of invalidItems.entries()) {
    writePendingFileSync(path, { runId: 'r1', pending: [item] });
    assert.equal(readPendingFileSync(path), undefined, `invalid item ${index} must quarantine the file`);
    assert.equal(existsSync(path), false, `invalid item ${index} must be moved aside`);
  }
  // 混入一条伪造条目的合法文件同样整体作废，不让 --grant 崩溃或错误沉淀。
  writePendingFileSync(path, { runId: 'r1', pending: [base, { ...base, id: 'p2', kind: 'nope' }] });
  assert.equal(readPendingFileSync(path), undefined);

  writePendingFileSync(path, { runId: 'r1', pending: [{ ...base, tool: 'WebFetch', input: { url: 'https://x.test' } }, questionItem()] });
  const parsed = readPendingFileSync(path);
  assert.equal(parsed.runId, 'r1');
  assert.equal(parsed.pending.length, 2);
  assert.deepEqual(parsed.pending[1].questions, [{ id: 'q1', question: 'Which shape?' }]);
});

test('contractBlockers keeps the structured contract block alongside the textual reason', () => {
  const block = {
    code: 'out_of_scope',
    message: 'Task asks for a rewrite',
    requestedContractChanges: ['Split T001 into two tasks'],
    affectedPaths: ['src/**']
  };
  const blockers = contractBlockers([
    taskRecord({ status: 'blocked_on_contract', lastError: 'stored error', contractBlockJson: JSON.stringify(block) }),
    taskRecord({ taskId: 'T002', title: 'u', status: 'blocked_on_contract', lastError: 'corrupt', contractBlockJson: '{nope' }),
    taskRecord({ taskId: 'T003', title: 'v', status: 'blocked_on_contract' }),
    taskRecord({ taskId: 'T004', title: 'w', status: 'approved' })
  ]);
  assert.deepEqual(blockers, [
    {
      taskId: 'T001', title: 't', attempts: 1, reason: 'Task asks for a rewrite',
      code: 'out_of_scope', requestedContractChanges: ['Split T001 into two tasks'], affectedPaths: ['src/**']
    },
    { taskId: 'T002', title: 'u', attempts: 1, reason: 'corrupt' },
    { taskId: 'T003', title: 'v', attempts: 1, reason: 'Worker requested a contract revision without a reason.' }
  ]);
});

test('snapshotAgents enforces a cross-vendor reviewer unless explicitly disabled', () => {
  const base = {
    version: 3, defaultAgent: 'worker-agent', crossVendorReview: true, concurrency: 1, staleAfterMs: 1, taskTimeoutMs: 1,
    workspace: { repoRoot: '.', stateDir: '', worktreesDir: '', baseRef: 'HEAD', branchPrefix: 'agent-team' },
    retry: { maxWorkerAttempts: 1, maxReviewCycles: 1 },
    backends: { claude: {}, codex: {}, opencode: {} },
    agents: { 'worker-agent': { backend: 'claude' }, 'reviewer-agent': { backend: 'claude' } },
    roles: { reviewer: 'reviewer-agent' },
    verification: { allowedCommandPrefixes: [] }
  };
  assert.throws(() => snapshotAgents(base), /Cross-vendor review is enforced: the reviewer backend "claude" must differ/);
  const disabled = { ...base, crossVendorReview: false };
  assert.equal(snapshotAgents(disabled).roles.reviewer.backend, 'claude');
  const crossVendor = {
    ...base,
    agents: { 'worker-agent': { backend: 'claude' }, 'reviewer-agent': { backend: 'codex' } }
  };
  assert.equal(snapshotAgents(crossVendor).roles.reviewer.backend, 'codex');
});

function policyFixture(backendPolicy) {
  return {
    id: 'p:r1', projectId: 'p', revision: 1,
    baseRef: 'HEAD',
    verificationAllowedCommandPrefixes: ['pnpm test'],
    agentProfileMapping: { defaultAgent: 'default-claude', agents: { 'default-claude': { backend: 'claude' } }, roles: {} },
    backendPolicy,
    createdBy: 'system', note: '', createdAt: ''
  };
}

function projectFixture() {
  return {
    id: 'p', gitCommonDir: '/repo/.git', repoRoot: '/repo', displayName: 'repo', gitIdentity: { root: '/repo' },
    currentPolicyRevisionId: 'p:r1', archivedAt: null, createdAt: '', updatedAt: ''
  };
}

test('runnerConfigFromProjectPolicy parses the crossVendorReview switch strictly', () => {
  const home = { root: '/home', stateDb: '/home/state.sqlite', runsDir: '/home/runs', worktreesDir: '/home/worktrees' };
  // 缺省强制。
  assert.equal(runnerConfigFromProjectPolicy(policyFixture({}), projectFixture(), home).crossVendorReview, true);
  // 显式关闭。
  assert.equal(
    runnerConfigFromProjectPolicy(policyFixture({ crossVendorReview: false }), projectFixture(), home).crossVendorReview,
    false
  );
  assert.throws(
    () => runnerConfigFromProjectPolicy(policyFixture({ crossVendorReview: 'yes' }), projectFixture(), home),
    /backendPolicy.crossVendorReview must be a boolean/
  );
});

test('status-grade commands refuse homes inside the process repository', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-team-review4-home-'));
  const rawRepoRoot = join(parent, 'repo');
  mkdirSync(rawRepoRoot, { recursive: true });
  // macOS 的 /var 是 /private/var 的符号链接：rev-parse 返回规范路径，比较两侧须同构。
  const repoRoot = realpathSync(rawRepoRoot);
  await git(repoRoot, ['init', '-q']);

  const inside = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(repoRoot, 'state') } });
  await assert.rejects(
    assertHomeOutsideProcessRepo(inside, repoRoot),
    /must never live inside the repository/
  );

  // 主仓库之外（含 linked worktree 的 git 公共目录防护）与非仓库目录都放行。
  const outside = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  await assertHomeOutsideProcessRepo(outside, repoRoot);
  const plain = mkdtempSync(join(tmpdir(), 'agent-team-review4-plain-'));
  await assertHomeOutsideProcessRepo(outside, plain);

  // 符号链接不得成为绕过：home 以另一种词法形式（/var vs /private/var）指向仓库内同样拒绝。
  const { symlinkSync } = await import('node:fs');
  const aliasRepo = join(parent, 'repo-alias');
  try {
    symlinkSync(repoRoot, aliasRepo, 'dir');
  } catch {
    // 平台不允许符号链接时跳过这一半断言（防护本身已由上一条覆盖）。
  }
  if (existsSync(aliasRepo)) {
    // home 目录真实存在时才能被 realpath 规范化：这正是防护既有误建目录的场景。
    mkdirSync(join(aliasRepo, 'state'), { recursive: true });
    const aliasInside = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(aliasRepo, 'state') } });
    await assert.rejects(
      assertHomeOutsideProcessRepo(aliasInside, repoRoot),
      /must never live inside the repository/
    );
  }
  // 尚不存在的 home 路径按词法解析，不抛 realpath 错误。
  const fresh = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'not-created-yet') } });
  await assertHomeOutsideProcessRepo(fresh, repoRoot);
});

test('killProcessTree falls back to a direct signal when the child owns no process group', () => {
  const originalKill = process.kill;
  const childKills = [];
  try {
    process.kill = () => { throw new Error('ESRCH'); };
    killProcessTree({ pid: 4242, kill: (signal) => childKills.push(signal) }, 'SIGTERM');
    assert.deepEqual(childKills, ['SIGTERM']);
  } finally {
    process.kill = originalKill;
  }
});

test('writeHandoff is idempotent, atomic, and can precede the done marker', () => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-team-review4-handoff-'));
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  ensureAgentTeamHome(home);
  const db = new StateDatabase(home.stateDb);
  try {
    db.createRun({ id: 'handoff-run', repoRoot: '/repo', goalFile: 'g', baseRef: 'HEAD', baseSha: 's', adapter: 'external' });
    db.insertTask('handoff-run', { id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] });
    db.updateRun('handoff-run', { status: 'integrating', integrationBranch: 'agent-team/handoff-run/integration', integrationCommit: 'abc' });

    // 未完成且未声明 pendingDone：不写。
    writeHandoff(db, home.runsDir, 'handoff-run');
    assert.equal(existsSync(join(home.runsDir, 'handoff-run', 'handoff.json')), false);

    // 集成阶段在标记 done 之前写入：产物完整且声明 done 语义。
    writeHandoff(db, home.runsDir, 'handoff-run', { pendingDone: true });
    const handoff = JSON.parse(readFileSync(join(home.runsDir, 'handoff-run', 'handoff.json'), 'utf8'));
    assert.equal(handoff.run.status, 'done');
    assert.equal(handoff.run.integrationCommit, 'abc');
    assert.match(readFileSync(join(home.runsDir, 'handoff-run', 'handoff.md'), 'utf8'), /# Run Handoff: handoff-run/);

    // done 之后重放修复路径幂等重写。
    db.updateRun('handoff-run', { status: 'done' });
    writeHandoff(db, home.runsDir, 'handoff-run');
    assert.equal(JSON.parse(readFileSync(join(home.runsDir, 'handoff-run', 'handoff.json'), 'utf8')).run.status, 'done');
  } finally {
    db.close();
  }
});

test('executeRunCommand pins replay to the persisted project, contract, and policy revision', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-team-review4-replay-'));
  const repoRoot = join(parent, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  ensureAgentTeamHome(home);

  const registry = new ProjectRegistry(home.stateDb);
  const registered = registry.registerProject({
    gitCommonDir: join(repoRoot, '.git'), repoRoot, displayName: 'replay',
    gitIdentity: { root: repoRoot }, id: 'cov-project',
    policy: {
      baseRef: 'HEAD', verificationAllowedCommandPrefixes: ['pnpm test'],
      agentProfileMapping: { defaultAgent: 'default-claude', agents: { 'default-claude': { backend: 'claude' }, 'default-codex': { backend: 'codex' } }, roles: { reviewer: 'default-codex' } },
      backendPolicy: {}
    }
  });
  registry.close();

  const contract = {
    version: 1,
    project: { id: 'cov-project', repoRoot, baseRef: 'HEAD' },
    tasks: [{ id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] }]
  };
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contract));

  const db = new StateDatabase(home.stateDb);
  const insertRun = (id, fields) => {
    db.createRun({ id, repoRoot, goalFile: 'g', baseRef: 'HEAD', baseSha: 'base', adapter: 'external', ...fields });
    db.insertTask(id, contract.tasks[0]);
    db.updateRun(id, { status: 'planned', manifestJson: JSON.stringify({ version: 1, title: 'r', summary: 'r', tasks: contract.tasks }) });
  };
  try {
    // 旧式 run（无持久化项目）：拒绝重放而不是按契约重新绑定项目。
    insertRun('legacy-run', {});
    await assert.rejects(
      executeRunCommand({ contractPath, runId: 'legacy-run', home }),
      /has no persisted project/
    );

    // 契约声明另一个项目：直接拒绝，绝不借项目配置执行旧 run。
    insertRun('mismatch-run', { projectId: 'other-project', projectPolicyRevisionId: 'other-project:r1' });
    await assert.rejects(
      executeRunCommand({ contractPath, runId: 'mismatch-run', home }),
      /belongs to project "other-project"/
    );

    // 非阻塞重放携带不同契约：显式拒绝（此前是静默忽略新契约内容）。
    insertRun('plain-run', { projectId: 'cov-project', projectPolicyRevisionId: registered.currentPolicyRevisionId, executionContractJson: JSON.stringify(contract) });
    const revised = JSON.parse(JSON.stringify(contract));
    revised.tasks[0].title = 'changed';
    const revisedPath = join(repoRoot, 'contract-v2.json');
    writeFileSync(revisedPath, JSON.stringify(revised));
    await assert.rejects(
      executeRunCommand({ contractPath: revisedPath, runId: 'plain-run', home }),
      /is not contract-blocked; replay requires the persisted contract/
    );

    // 相同契约的重放路径保持可用（任务无可运行后端 → 自然停止点，而非重绑项目）。
    const outcome = await executeRunCommand({ contractPath, runId: 'plain-run', home, backends: { claude: {}, codex: {}, opencode: {} } });
    assert.equal(outcome.runStatus, 'needs_attention');

    // 有项目但未固化策略修订的历史 run：回退项目当前策略，仍按持久化项目重放。
    insertRun('legacy-revision-run', { projectId: 'cov-project', executionContractJson: JSON.stringify(contract) });
    const legacyOutcome = await executeRunCommand({ contractPath, runId: 'legacy-revision-run', home, backends: { claude: {}, codex: {}, opencode: {} } });
    assert.equal(legacyOutcome.runStatus, 'needs_attention');
  } finally {
    db.close();
  }
});

test('a blocked task does not stop the run: independent tasks are batched into one exit', async () => {
  const repoRoot = scratchRepo();
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratchDir('agent-team-review4-batch-home-'), 'home') } });
  ensureAgentTeamHome(home);
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify({
    version: 1,
    project: { id: 'batch-project', repoRoot, baseRef: 'HEAD' },
    tasks: [
      taskSpecJson('T001', ['src/a/**']),
      taskSpecJson('T002', ['src/b/**'])
    ]
  }));

  // 每个 worker 撞白名单外命令后以 blocked 结束；并发槽位 1 → 两个任务先后被调度。
  let approvalsAsked = 0;
  const backend = {
    id: 'claude', capabilities: { maxTurns: true, resumeSession: true },
    async discover() { return { backend: 'claude', installed: true, authed: true }; },
    async listModels() { return []; },
    async probe() { return { ok: true, latencyMs: 1 }; },
    async openSession(spec) {
      return {
        async interrupt() {},
        async close() {},
        completion: async () => {
          if (spec.role !== 'worker') throw new Error(`unexpected role: ${spec.role}`);
          approvalsAsked += 1;
          const decision = await spec.requestApproval({
            backend: 'claude', role: 'worker', cwd: spec.cwd, taskId: spec.taskId,
            kind: 'command', tool: 'Bash', input: { command: `pnpm add pkg-${spec.taskId}` }, allowSession: false
          });
          return decision === 'deny'
            ? { ok: true, output: { status: 'blocked', summary: 'denied', testsRun: [], knownRisks: [], blockedReason: 'need pnpm add' }, timedOut: false, stalled: false }
            : { ok: true, output: { status: 'completed', summary: 'ok', testsRun: [], knownRisks: [] }, timedOut: false, stalled: false };
        }
      };
    }
  };

  // quiescence：跑到自然停止点，一次退出携带全部 pending（审批批量收集）。
  const outcome = await executeRunCommand({
    contractPath, home, backends: { claude: backend, codex: backend, opencode: backend },
    exitMode: 'quiescence', maxParallel: 1
  });
  assert.equal(outcome.exitCode, 10);
  assert.equal(outcome.kind, 'needs_approval');
  assert.equal(outcome.runStatus, 'needs_attention');
  assert.deepEqual(outcome.pending.map((item) => item.taskId), ['T001', 'T002']);
  assert.equal(approvalsAsked, 2);
});

function scratchRepo() {
  const repoRoot = join(scratchDir('agent-team-review4-batch-repo-'), 'repo');
  mkdirSync(join(repoRoot, 'src', 'a'), { recursive: true });
  mkdirSync(join(repoRoot, 'src', 'b'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'a', 'a.txt'), 'a\n', 'utf8');
  writeFileSync(join(repoRoot, 'src', 'b', 'b.txt'), 'b\n', 'utf8');
  for (const args of [['init', '-q'], ['config', 'user.email', 't@e.com'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '-q', '-m', 'base']]) {
    execFileSync('git', args, { cwd: repoRoot });
  }
  return repoRoot;
}

function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function taskSpecJson(id, allowedPaths) {
  return { id, title: id, description: 'd', dependsOn: [], allowedPaths, blockedPaths: [], acceptance: ['a'], verificationCommands: [] };
}
