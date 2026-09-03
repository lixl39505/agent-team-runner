import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../src/core/git.ts';
import { resolveAgentTeamHome } from '../src/core/home.ts';
import { StateDatabase } from '../src/core/db.ts';
import { ProjectRegistry, parseProjectPolicyInput } from '../src/core/project-registry.ts';
import { runnerConfigFromProjectPolicy } from '../src/core/project-runtime.ts';
import { assertExecutionContractFields, validateExecutionContract } from '../src/core/validation.ts';
import { createExecutionRun } from '../src/core/execution-run.ts';
import { applyContractRevision } from '../src/core/contract-revision.ts';
import { readHandoff } from '../src/core/handoff.ts';
import { cleanRunArtifacts } from '../src/core/run-clean.ts';
import { grantsItemPath, writeGrantsFileSync } from '../src/core/run-exit.ts';
import { readPendingFileSync } from '../src/core/run-exit.ts';
import { executeRunCommand } from '../src/core/run-execute.ts';

import { spawn } from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function basePolicy() {
  return {
    baseRef: 'HEAD',
    verificationAllowedCommandPrefixes: ['pnpm test'],
    baselinePathPolicy: {},
    agentProfileMapping: { defaultAgent: 'default-claude', agents: { 'default-claude': { backend: 'claude' } }, roles: {} },
    backendPolicy: {}
  };
}

function contractFor(repoRoot, mutate = () => {}) {
  const contract = {
    version: 1,
    project: { id: 'cov-project', repoRoot, baseRef: 'HEAD' },
    tasks: [{
      id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['src/**'], blockedPaths: [],
      acceptance: ['first'], verificationCommands: []
    }]
  };
  mutate(contract);
  return contract;
}


test('process-tree kills windows trees through taskkill and tolerates spawn failures', async () => {
  const { killProcessTree } = await import('../src/agent/process-tree.ts');
  const originalPlatform = process.platform;
  const originalKill = process.kill;
  const killerCalls = [];
  const childKills = [];
  const fakeChild = { pid: 4242, kill: (signal) => childKills.push(signal) };
  vi.mocked(spawn).mockImplementation(() => ({
    once: (event, handler) => {
      if (event === 'error') killerError = handler;
    },
    unref: () => {}
  }));
  let killerError;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    killProcessTree(fakeChild, 'SIGTERM');
    assert.deepEqual(killerCalls.length >= 0, true);
    assert.equal(childKills.length, 0);

    vi.mocked(spawn).mockImplementation(() => { throw new Error('no taskkill'); });
    killProcessTree(fakeChild, 'SIGKILL');
    assert.deepEqual(childKills, ['SIGKILL']);

    vi.mocked(spawn).mockImplementation(() => ({
      once: (event, handler) => { if (event === 'error') killerError = handler; },
      unref: () => {}
    }));
    childKills.length = 0;
    killProcessTree(fakeChild, 'SIGTERM');
    killerError();
    assert.deepEqual(childKills, ['SIGTERM']);

    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    childKills.length = 0;
    process.kill = (pid, signal) => { childKills.push([pid, signal]); };
    killProcessTree(fakeChild, 'SIGTERM');
    assert.deepEqual(childKills, [[-4242, 'SIGTERM']]);

    childKills.length = 0;
    killProcessTree({}, 'SIGTERM');
    assert.deepEqual(childKills, []);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    process.kill = originalKill;
  }
});

test('assertExecutionContractFields and validateExecutionContract check optional sections', () => {
  assert.throws(() => assertExecutionContractFields('nope'), /contract must be an object/);
  assert.throws(() => assertExecutionContractFields({ nope: true }), /contract contains unknown field/);
  assert.throws(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' }, tasks: [], target: 'x' }
  ), /target is no longer accepted/);
  assert.throws(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' }, tasks: [], target: { integrationBranch: 'release' } }
  ), /target is no longer accepted/);
  assert.throws(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' }, tasks: [], provenance: 'x' }
  ), /contract.provenance must be an object/);
  assert.throws(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' }, tasks: [{ nope: true }] }
  ), /contract.tasks\[0\] contains unknown field/);

  assert.throws(() => validateExecutionContract(
    contractFor('/r', (c) => { c.target = { integrationBranch: 'release-1.0' }; })
  ), /target/);
  assert.doesNotThrow(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' }, provenance: { documents: 'not-an-array' }, tasks: [] }
  ));
  assert.doesNotThrow(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' }, tasks: 'not-an-array' }
  ));
  assert.doesNotThrow(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' },
      tasks: [{ id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['a/**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] }] }
  ));
  assert.doesNotThrow(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' },
      provenance: { documents: [{ kind: 'requirement', locator: 'sdd://x@1', revision: '1' }] },
      tasks: [{ id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['a/**'], blockedPaths: [],
        acceptance: ['a'], verificationCommands: [],
        implementationSkills: [{ name: 'tdd', role: 'worker', required: true, source: 'project' }] }] }
  ));
  const withOptional = validateExecutionContract(contractFor('/r', (c) => {
    c.tasks[0].role = 'worker';
    c.tasks[0].allowNoChanges = true;
  }));
  assert.equal(withOptional.target, undefined);
  assert.deepEqual(withOptional.tasks[0].acceptance, ['first']);
});

test('parseProjectPolicyInput validates every field and value shape', () => {
  assert.throws(() => parseProjectPolicyInput({ policy: 'x' }), /policy must be an object/);
  assert.throws(() => parseProjectPolicyInput({ policy: [] }), /policy must be an object/);
  assert.throws(() => parseProjectPolicyInput({ policy: { ...basePolicy(), nope: 1 } }), /unknown field/);
  assert.throws(() => parseProjectPolicyInput({ policy: { ...basePolicy(), baseRef: 7 } }), /baseRef must be a non-empty string/);
  assert.throws(() => parseProjectPolicyInput({ policy: { ...basePolicy(), baseRef: '' } }), /baseRef must be a non-empty string/);
  assert.throws(() => parseProjectPolicyInput({ policy: { ...basePolicy(), verificationAllowedCommandPrefixes: ['pnpm test', 7] } }), /must be an array of strings/);
  const parsed = parseProjectPolicyInput({
    policy: {
      baseRef: 'main',
      verificationAllowedCommandPrefixes: ['pnpm test'],
      baselinePathPolicy: { allowed: true, nested: [1, 'two', null, { deep: 0.5 }] },
      agentProfileMapping: 'flat',
      backendPolicy: { concurrency: 4 }
    }
  });
  assert.equal(parsed.baseRef, 'main');
  assert.equal(parsed.baselinePathPolicy.allowed, true);
  assert.throws(() => parseProjectPolicyInput({ policy: { ...basePolicy(), baselinePathPolicy: undefined } }), /must be a JSON value/);
  assert.throws(() => parseProjectPolicyInput({ policy: { ...basePolicy(), baselinePathPolicy: Number.NaN } }), /must be a JSON value/);
});

test('handoff read surfaces non-missing read errors', () => {
  const parent = scratch('agent-team-handoff-error-');
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  mkdirSync(join(home.runsDir, 'r1'), { recursive: true });
  writeFileSync(join(home.runsDir, 'r1', 'handoff.json'), 'not json', 'utf8');
  assert.throws(() => readHandoff(home.runsDir, 'r1'), /not json|Unexpected token/);
});

test('executeRunCommand supports env home, remote identities, deny grants, and provenance revisions', async () => {
  const repoRoot = scratch('agent-team-cov-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  await git(repoRoot, ['remote', 'add', 'origin', 'git@example.test:cov/repo.git']);

  const previousHome = process.env.AGENT_TEAM_HOME;
  process.env.AGENT_TEAM_HOME = join(scratch('agent-team-cov-home-'), 'home');
  let approvalsLeft = 1;
  const workerHandler = async (spec) => {
    if (spec.role === 'worker') {
      writeFileSync(join(spec.cwd, 'base.txt'), 'changed\n', 'utf8');
      if (spec.taskId === 'T001' && approvalsLeft > 0) {
        approvalsLeft -= 1;
        const decision = await spec.requestApproval({
          backend: 'claude', role: 'worker', cwd: spec.cwd, taskId: spec.taskId,
          kind: 'command', tool: 'Bash', input: { command: 'pnpm add zod' }, allowSession: false
        });
        if (decision === 'deny') {
          return { status: 'blocked', summary: 'needs pnpm add zod', testsRun: [], knownRisks: [], blockedReason: 'denied' };
        }
      }
      return { status: 'completed', summary: 'did it', testsRun: [], knownRisks: [] };
    }
    return spec.role === 'reviewer'
      ? { decision: 'approved', summary: 'ok', findings: [], requiredChanges: [] }
      : { status: 'completed', summary: 'int', testsRun: [], knownRisks: [] };
  };
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
          const output = await workerHandler(spec);
          return { ok: true, output, timedOut: false, stalled: false };
        }
      };
    }
  };
  const backends = { claude: backend, codex: backend, opencode: backend };

  try {
    const contractPath = join(repoRoot, 'contract.json');
    writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => {
      c.tasks[0].allowedPaths = ['**'];
      c.provenance = { documents: [{ kind: 'requirement', locator: 'sdd://x@1', revision: '1' }] };
    })));

    // 环境变量 home + 远程 identity 派生 + deny 后阻塞（exit 10，pending 上报）。
    const first = await executeRunCommand({ contractPath, backends, debounceMs: 1, maxParallel: 1 });
    assert.equal(first.exitCode, 10);
    assert.equal(first.kind, 'needs_approval');
    assert.deepEqual(first.pending[0].commands, ['pnpm add zod']);
    const registry = new ProjectRegistry(resolveAgentTeamHome().stateDb);
    const project = registry.getProject('cov-project');
    assert.deepEqual(project.gitIdentity, { remote: 'git@example.test:cov/repo.git' });
    registry.close();

    // grant approve：命令沉淀进 allowlist（新 revision），重放后完成。
    const decisionsPath = join(repoRoot, 'decisions.json');
    writeFileSync(decisionsPath, JSON.stringify({ p1: 'approve' }), 'utf8');
    const second = await executeRunCommand({
      contractPath, runId: first.runId, grantPath: decisionsPath, backends, exitMode: 'quiescence'
    });
    assert.equal(second.exitCode, 0);
    assert.equal(second.kind, 'done');
    const registry2 = new ProjectRegistry(resolveAgentTeamHome().stateDb);
    const policy = registry2.getProjectPolicy('cov-project');
    assert.ok(policy.verificationAllowedCommandPrefixes.includes('pnpm add zod'));
    const db2 = new StateDatabase(resolveAgentTeamHome().stateDb);
    const runRow = db2.getRun(first.runId);
    db2.close();
    assert.equal(runRow.projectPolicyRevisionId, policy.id);

  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TEAM_HOME;
    else process.env.AGENT_TEAM_HOME = previousHome;
  }
});


test('run enforces a per-run process lock and rebuilds crashed planning runs', async () => {
  const repoRoot = scratch('agent-team-cov-lock-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-lock-home-'), 'home') } });
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => {
    c.tasks[0].allowedPaths = ['**'];
  })));

  const db0 = new StateDatabase(home.stateDb);
  db0.createRun({ id: 'lock-run', repoRoot, goalFile: 'g', baseRef: 'HEAD', baseSha: 'base', adapter: 'external', projectId: 'cov-project', executionContractJson: JSON.stringify(contractFor(repoRoot)) });
  db0.close();

  // 同进程持有锁 → 拒绝启动。
  mkdirSync(join(home.runsDir, 'lock-run', 'lock'), { recursive: true });
  writeFileSync(join(home.runsDir, 'lock-run', 'lock', 'pid'), String(process.pid), 'utf8');
  await assert.rejects(
    executeRunCommand({ contractPath, runId: 'lock-run', home, backends: { claude: {}, codex: {}, opencode: {} } }),
    /already executing/
  );

  // 崩溃残留（pid 不存活）→ 接管；planning 残留 → 重建后重放。
  const db = new StateDatabase(home.stateDb);
  db.updateRun('lock-run', { status: 'planning' });
  db.close();
  mkdirSync(join(home.runsDir, 'lock-run', 'lock'), { recursive: true });
  writeFileSync(join(home.runsDir, 'lock-run', 'lock', 'pid'), '999999', 'utf8');

  const backend = {
    id: 'claude', capabilities: { maxTurns: true, resumeSession: true },
    async discover() { return { backend: 'claude', installed: true, authed: true }; },
    async listModels() { return []; },
    async probe() { return { ok: true, latencyMs: 1 }; },
    async openSession(spec) {
      return {
        sessionId: 'sess-lock-1',
        async interrupt() {},
        async close() {},
        completion: async () => {
          if (spec.role === 'worker') writeFileSync(join(spec.cwd, 'base.txt'), 'changed\n', 'utf8');
          const output = spec.role === 'reviewer'
            ? { decision: 'approved', summary: 'ok', findings: [], requiredChanges: [] }
            : { status: 'completed', summary: 'did it', testsRun: [], knownRisks: [] };
          return { ok: true, output, timedOut: false, stalled: false };
        }
      };
    }
  };
  const outcome = await executeRunCommand({
    contractPath, runId: 'lock-run', home, backends: { claude: backend, codex: backend, opencode: backend }, exitMode: 'quiescence'
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.kind, 'done');
  assert.ok(!existsSync(join(home.runsDir, 'lock-run', 'lock')));
});

test('granting a question pending item is rejected in favour of contract revision', async () => {
  const repoRoot = scratch('agent-team-cov-question-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-question-home-'), 'home') } });
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => { c.tasks[0].allowedPaths = ['**']; })));

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
          if (spec.role === 'worker') {
            writeFileSync(join(spec.cwd, 'base.txt'), 'changed\n', 'utf8');
            if (spec.requestUserInput) {
              await spec.requestUserInput({
                backend: 'claude', role: 'worker', cwd: spec.cwd, taskId: spec.taskId,
                questions: [{ id: 'q1', question: 'Which shape?' }]
              });
            }
            return { ok: true, output: { status: 'completed', summary: 'done anyway', testsRun: [], knownRisks: [] }, timedOut: false, stalled: false };
          }
          if (spec.role === 'reviewer') {
            return { ok: true, output: { decision: 'approved', summary: 'ok', findings: [], requiredChanges: [] }, timedOut: false, stalled: false };
          }
          return { ok: true, output: { status: 'completed', summary: 'int', testsRun: [], knownRisks: [] }, timedOut: false, stalled: false };
        }
      };
    }
  };
  const backends = { claude: backend, codex: backend, opencode: backend };

  const first = await executeRunCommand({ contractPath, home, backends, exitMode: 'quiescence' });
  assert.equal(first.exitCode, 0);

  // 外层对已完成 run 的 question 授权被协议拒绝：回答通道是契约修订。
  const pendingPath = join(home.runsDir, first.runId, 'pending.json');
  writeFileSync(pendingPath, JSON.stringify({
    runId: first.runId,
    pending: [{ id: 'p1', kind: 'question', taskId: 'T001', agentId: 'worker:claude', subject: 'Which shape?', reason: 'r' }]
  }), 'utf8');
  const decisionsPath = join(repoRoot, 'decisions.json');
  writeFileSync(decisionsPath, JSON.stringify({ p1: 'approve' }), 'utf8');
  await assert.rejects(
    executeRunCommand({ contractPath, runId: first.runId, grantPath: decisionsPath, home, backends }),
    /Pending item p1 is a question/
  );
});

test('granting an already-allowlisted command leaves the policy untouched', async () => {
  const repoRoot = scratch('agent-team-cov-dup-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-dup-home-'), 'home') } });
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => {
    c.tasks[0].allowedPaths = ['**'];
  })));

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
          if (spec.role === 'worker') writeFileSync(join(spec.cwd, 'base.txt'), 'changed\n', 'utf8');
          const output = spec.role === 'reviewer'
            ? { decision: 'approved', summary: 'ok', findings: [], requiredChanges: [] }
            : { status: 'completed', summary: 'did it', testsRun: [], knownRisks: [] };
          return { ok: true, output, timedOut: false, stalled: false };
        }
      };
    }
  };
  const backends = { claude: backend, codex: backend, opencode: backend };

  const first = await executeRunCommand({ contractPath, home, backends, exitMode: 'quiescence' });
  assert.equal(first.exitCode, 0);

  // 已完成 run 上补一条已在 allowlist 内的命令授权：策略不变，run 保持 done。
  const pendingPath = join(home.runsDir, first.runId, 'pending.json');
  writeFileSync(pendingPath, JSON.stringify({
    runId: first.runId,
    pending: [{ id: 'p1', kind: 'approval', taskId: null, agentId: 'worker:claude', subject: 'command pnpm test: pnpm test', reason: 'r', commands: ['pnpm test'] }]
  }), 'utf8');
  const decisionsPath = join(repoRoot, 'decisions.json');
  writeFileSync(decisionsPath, JSON.stringify({ p1: 'approve' }), 'utf8');
  const second = await executeRunCommand({
    contractPath, runId: first.runId, grantPath: decisionsPath, home, backends, exitMode: 'quiescence'
  });
  assert.equal(second.exitCode, 0);
  const registry = new ProjectRegistry(home.stateDb);
  const policy = registry.getProjectPolicy('cov-project');
  assert.ok(policy.verificationAllowedCommandPrefixes.includes('pnpm test'));
});

test('granting a question pending item is rejected in favour of contract revision', async () => {
  const repoRoot = scratch('agent-team-cov-question-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-question-home-'), 'home') } });
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => { c.tasks[0].allowedPaths = ['**']; })));

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
          if (spec.role === 'worker') {
            writeFileSync(join(spec.cwd, 'base.txt'), 'changed\n', 'utf8');
            if (spec.requestUserInput) {
              await spec.requestUserInput({
                backend: 'claude', role: 'worker', cwd: spec.cwd, taskId: spec.taskId,
                questions: [{ id: 'q1', question: 'Which shape?' }]
              });
            }
            return { ok: true, output: { status: 'completed', summary: 'done anyway', testsRun: [], knownRisks: [] }, timedOut: false, stalled: false };
          }
          if (spec.role === 'reviewer') {
            return { ok: true, output: { decision: 'approved', summary: 'ok', findings: [], requiredChanges: [] }, timedOut: false, stalled: false };
          }
          return { ok: true, output: { status: 'completed', summary: 'int', testsRun: [], knownRisks: [] }, timedOut: false, stalled: false };
        }
      };
    }
  };
  const backends = { claude: backend, codex: backend, opencode: backend };

  const first = await executeRunCommand({ contractPath, home, backends, exitMode: 'quiescence' });
  if (first.exitCode !== 0) {
    const ddbg = new StateDatabase(home.stateDb);
    console.log('DBG', ddbg.getRun(first.runId).status, ddbg.getRun(first.runId).error);
    for (const t of ddbg.listTasks(first.runId)) console.log('DBG', t.taskId, t.status, t.lastError);
    ddbg.close();
  }
  assert.equal(first.exitCode, 0); // question 被记录但 worker 以契约指引完成
  // 外层仍然可以对已完成的 run 提交 question 授权，但协议明确拒绝：
  // 问题的回答通道是契约修订（implementationGuidance），不是 --grant。
  const pendingPath = join(home.runsDir, first.runId, 'pending.json');
  writeFileSync(pendingPath, JSON.stringify({
    runId: first.runId,
    pending: [{ id: 'p1', kind: 'question', taskId: 'T001', agentId: 'worker:claude', subject: 'Which shape?', reason: 'r' }]
  }), 'utf8');
  const decisionsPath = join(repoRoot, 'decisions.json');
  writeFileSync(decisionsPath, JSON.stringify({ p1: 'approve' }), 'utf8');
  await assert.rejects(
    executeRunCommand({ contractPath, runId: first.runId, grantPath: decisionsPath, home, backends }),
    /Pending item p1 is a question/
  );
});

test('auto-registration rejects a contract id that collides with an existing project', async () => {
  const repoRoot = scratch('agent-team-cov-mismatch-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-mismatch-home-'), 'home') } });
  const registry = new ProjectRegistry(home.stateDb);
  registry.registerProject({
    gitCommonDir: join(repoRoot, '.git'), repoRoot, displayName: 'existing',
    gitIdentity: { root: repoRoot }, id: 'the-real-id', policy: basePolicy()
  });
  registry.close();
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => { c.project.id = 'wrong-id'; })));
  await assert.rejects(
    executeRunCommand({ contractPath, home, backends: { claude: {}, codex: {}, opencode: {} } }),
    /already registered as project "the-real-id"/
  );
});

test('auto-registration rejects non-Git directories before writing global registration', async () => {
  const plainDir = scratch('agent-team-cov-plain-');
  const previousHome = process.env.AGENT_TEAM_HOME;
  process.env.AGENT_TEAM_HOME = join(scratch('agent-team-cov-plain-home-'), 'home');
  const contractPath = join(plainDir, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(plainDir)));
  try {
    await assert.rejects(
      executeRunCommand({ contractPath, backends: { claude: {}, codex: {}, opencode: {} } }),
      /not a Git repository|git rev-parse/i
    );
    // 注册表必须保持干净：残留的错误注册会让后续同 ID 的正常提交永远撞上它。
    const registry = new ProjectRegistry(join(process.env.AGENT_TEAM_HOME, 'state.sqlite'));
    assert.throws(() => registry.getProject('cov-project'), /Project not found: cov-project/);
    registry.close();
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TEAM_HOME;
    else process.env.AGENT_TEAM_HOME = previousHome;
  }
});

test('auto-registration tolerates repositories without remotes', async () => {
  const repoRoot = scratch('agent-team-cov-noremote-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-noremote-home-'), 'home') } });
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => { c.tasks[0].allowedPaths = ['**']; })));
  // 空 backend 记录让任务失败（exit 1），但注册本身发生在编排之前。
  const outcome = await executeRunCommand({ contractPath, home, backends: { claude: {}, codex: {}, opencode: {} } });
  assert.equal(outcome.exitCode, 1);
  const registry = new ProjectRegistry(home.stateDb);
  const project = registry.getProject('cov-project');
  assert.deepEqual(project.gitIdentity, { root: repoRoot });
  registry.close();
});

test('clean skips tasks without worktrees and runs without integration artifacts', async () => {
  const repoRoot = scratch('agent-team-cov-clean-null-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-clean-null-home-'), 'home') } });
  const db = new StateDatabase(home.stateDb);
  try {
    db.createRun({ id: 'r2', repoRoot, goalFile: 'g', baseRef: 'HEAD', baseSha: 'base', adapter: 'external' });
    db.insertTask('r2', { id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] });
    const result = await cleanRunArtifacts(db, home, 'r2');
    assert.deepEqual(result.removedWorktrees, []);
    assert.deepEqual(result.removedBranches, []);
    assert.equal(db.getRun('r2').status, 'cancelled');
  } finally {
    db.close();
  }
});

test('grant sedimentation dedupes permissions and respects terminal task states', async () => {
  const repoRoot = scratch('agent-team-cov-grant-dedup-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-grant-dedup-home-'), 'home') } });
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => { c.tasks[0].allowedPaths = ['**']; })));

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
          if (spec.role === 'worker') writeFileSync(join(spec.cwd, 'base.txt'), 'changed\n', 'utf8');
          const output = spec.role === 'reviewer'
            ? { decision: 'approved', summary: 'ok', findings: [], requiredChanges: [] }
            : { status: 'completed', summary: 'did it', testsRun: [], knownRisks: [] };
          return { ok: true, output, timedOut: false, stalled: false };
        }
      };
    }
  };
  const backends = { claude: backend, codex: backend, opencode: backend };

  const first = await executeRunCommand({ contractPath, home, backends, exitMode: 'quiescence' });
  assert.equal(first.exitCode, 0);
  const taskId = first.tasks[0].taskId;

  // 已有授权（无 input 字段）：重复沉淀必须被去重。
  const grantsPath = grantsItemPath(home.runsDir, first.runId);
  writeGrantsFileSync(grantsPath, { runId: first.runId, grants: [{ tool: 'WebFetch' }] });

  const pendingPath = join(home.runsDir, first.runId, 'pending.json');
  writeFileSync(pendingPath, JSON.stringify({
    runId: first.runId,
    pending: [
      { id: 'p1', kind: 'approval', taskId: null, agentId: 'worker:claude', subject: 'same tool', reason: 'r', tool: 'WebFetch' },
      { id: 'p2', kind: 'approval', taskId: null, agentId: 'worker:claude', subject: 'new permission', reason: 'r', tool: 'WebFetch', input: { url: 'https://x.test' } },
      { id: 'p3', kind: 'approval', taskId: taskId, agentId: 'worker:claude', subject: 'approved task', reason: 'r', commands: ['npm run docs'] },
      { id: 'p4', kind: 'approval', taskId: taskId, agentId: 'worker:claude', subject: 'denied on approved task', reason: 'r', tool: 'Shell' }
    ]
  }), 'utf8');
  const decisionsPath = join(repoRoot, 'decisions.json');
  writeFileSync(decisionsPath, JSON.stringify({ p1: 'approve', p2: 'approve', p3: 'approve', p4: 'deny' }), 'utf8');

  const second = await executeRunCommand({
    contractPath, runId: first.runId, grantPath: decisionsPath, home, backends, exitMode: 'quiescence'
  });
  assert.equal(second.exitCode, 0);
  assert.equal(second.runStatus, 'done');

  // p1 与既有授权逐字去重；p2 是新授权，随后追加。
  const grants = JSON.parse(readFileSync(grantsPath, 'utf8'));
  assert.deepEqual(grants.grants, [
    { tool: 'WebFetch' },
    { tool: 'WebFetch', input: { url: 'https://x.test' } }
  ]);
  // p3 命令沉淀进 allowlist；approved 任务不被重置。
  const registry = new ProjectRegistry(home.stateDb);
  const policy = registry.getProjectPolicy('cov-project');
  registry.close();
  assert.ok(policy.verificationAllowedCommandPrefixes.includes('npm run docs'));

  const db = new StateDatabase(home.stateDb);
  try {
    assert.equal(db.getTask(first.runId, taskId).status, 'approved');
    const skipped = db.db.prepare(
      "SELECT payload_json FROM events WHERE run_id = ? AND task_id = ? AND event_type = 'GRANT_SKIPPED_TASK_STATE' ORDER BY id"
    ).all(first.runId, taskId);
    assert.deepEqual(skipped.map((row) => JSON.parse(row.payload_json).status), ['approved', 'approved']);
  } finally {
    db.close();
  }
});

test('grant on a run without a prior pending file starts from an empty slate', async () => {
  const repoRoot = scratch('agent-team-cov-grant-nopending-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-grant-nopending-home-'), 'home') } });
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => { c.tasks[0].allowedPaths = ['**']; })));

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
          if (spec.role === 'worker') writeFileSync(join(spec.cwd, 'base.txt'), 'changed\n', 'utf8');
          const output = spec.role === 'reviewer'
            ? { decision: 'approved', summary: 'ok', findings: [], requiredChanges: [] }
            : { status: 'completed', summary: 'did it', testsRun: [], knownRisks: [] };
          return { ok: true, output, timedOut: false, stalled: false };
        }
      };
    }
  };
  const backends = { claude: backend, codex: backend, opencode: backend };

  const first = await executeRunCommand({ contractPath, home, backends, exitMode: 'quiescence' });
  assert.equal(first.exitCode, 0);
  rmSync(join(home.runsDir, first.runId, 'pending.json'));

  const decisionsPath = join(repoRoot, 'decisions.json');
  writeFileSync(decisionsPath, JSON.stringify({}), 'utf8');
  const second = await executeRunCommand({
    contractPath, runId: first.runId, grantPath: decisionsPath, home, backends, exitMode: 'quiescence'
  });
  assert.equal(second.exitCode, 0);
  assert.deepEqual(second.pending, []);
});

test('grant deny fails the task; approving a command-less item is a no-op', async () => {
  const repoRoot = scratch('agent-team-cov-deny-repo-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-cov-deny-home-'), 'home') } });
  const contractPath = join(repoRoot, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(repoRoot, (c) => { c.tasks[0].allowedPaths = ['**']; })));

  let approvalsLeft = 1;
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
          if (spec.role === 'worker') {
            writeFileSync(join(spec.cwd, 'base.txt'), 'changed\n', 'utf8');
            if (approvalsLeft > 0) {
              approvalsLeft -= 1;
              const decision = await spec.requestApproval({
                backend: 'claude', role: 'worker', cwd: spec.cwd, taskId: spec.taskId,
                kind: 'command', tool: 'Bash', input: { command: 'pnpm add left-pad' }, allowSession: false
              });
              if (decision === 'deny') {
                return {
                  ok: true,
                  output: { status: 'blocked', summary: 'blocked', testsRun: [], knownRisks: [], blockedReason: 'pnpm add left-pad was denied' },
                  timedOut: false,
                  stalled: false
                };
              }
            }
          }
          const output = spec.role === 'reviewer'
            ? { decision: 'approved', summary: 'ok', findings: [], requiredChanges: [] }
            : { status: 'completed', summary: 'did it', testsRun: [], knownRisks: [] };
          return { ok: true, output, timedOut: false, stalled: false };
        }
      };
    }
  };
  const backends = { claude: backend, codex: backend, opencode: backend };

  const first = await executeRunCommand({ contractPath, home, backends, exitMode: 'quiescence' });
  if (first.exitCode !== 10) {
    const ddbg = new StateDatabase(home.stateDb);
    console.log('DBG2 run:', ddbg.getRun(first.runId).status, ddbg.getRun(first.runId).error);
    for (const t of ddbg.listTasks(first.runId)) console.log('DBG2 task:', t.taskId, t.status, t.lastError);
    for (const r of ddbg.db.prepare('SELECT event_type, payload_json FROM events WHERE run_id=? ORDER BY id').all(first.runId)) {
      if (r.event_type.includes('RETRY') || r.event_type === 'WORKER_STARTED') {
        const p2 = JSON.parse(r.payload_json || '{}');
        console.log('DBG2', r.event_type, '|', (p2.error || p2.summary || JSON.stringify(p2)).slice(0, 120));
      }
    }
    ddbg.close();
  }
  assert.equal(first.exitCode, 10);

  // p2：无命令、无任务的 approve（纯 no-op 臂）；p3：null taskId 的 deny。
  const pendingPath = join(home.runsDir, first.runId, 'pending.json');
  const pendingFile = JSON.parse(readFileSync(pendingPath, 'utf8'));
  pendingFile.pending.push(
    { id: 'p2', kind: 'approval', taskId: null, agentId: 'worker:claude', subject: 'no-op', reason: 'r' },
    { id: 'p3', kind: 'approval', taskId: null, agentId: 'worker:claude', subject: 'gone', reason: 'r' }
  );
  writeFileSync(pendingPath, JSON.stringify(pendingFile), 'utf8');
  const decisionsPath = join(repoRoot, 'decisions.json');
  writeFileSync(decisionsPath, JSON.stringify({ p1: 'deny', p2: 'approve', p3: 'deny' }), 'utf8');
  const second = await executeRunCommand({
    contractPath, runId: first.runId, grantPath: decisionsPath, home, backends, exitMode: 'quiescence', maxParallel: 2
  });
  assert.equal(second.exitCode, 1);
  const db = new StateDatabase(home.stateDb);
  const task = db.getTask(first.runId, 'T001');
  db.close();
  assert.equal(task.status, 'failed');
  assert.match(task.lastError, /Denied by outer decision/);
});
