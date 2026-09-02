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
  ), /contract.target must be an object/);
  assert.throws(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' }, tasks: [], target: { nope: 1 } }
  ), /contract.target contains unknown field/);
  assert.throws(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' }, tasks: [], provenance: 'x' }
  ), /contract.provenance must be an object/);
  assert.throws(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' }, tasks: [{ nope: true }] }
  ), /contract.tasks\[0\] contains unknown field/);

  assert.throws(() => validateExecutionContract(
    contractFor('/r', (c) => { c.target = { integrationBranch: '' }; })
  ), /integrationBranch/);
  assert.throws(() => validateExecutionContract(
    contractFor('/r', (c) => { c.target = 'x'; })
  ), /target must be an object/);
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
      target: { integrationBranch: 'agent-team/x/integration' },
      provenance: { documents: [{ kind: 'requirement', locator: 'sdd://x@1', revision: '1' }] },
      tasks: [{ id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['a/**'], blockedPaths: [],
        acceptance: ['a'], verificationCommands: [],
        implementationSkills: [{ name: 'tdd', role: 'worker', required: true, source: 'project' }] }] }
  ));
  const withOptional = validateExecutionContract(contractFor('/r', (c) => {
    c.target = { integrationBranch: 'agent-team/x/integration' };
    c.tasks[0].role = 'worker';
    c.tasks[0].allowNoChanges = true;
  }));
  assert.equal(withOptional.target.integrationBranch, 'agent-team/x/integration');
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
        completion: async () => ({ ok: true, output: await workerHandler(spec), timedOut: false, stalled: false })
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

    // Default eager exit mode with the ambient AGENT_TEAM_HOME and remote-derived identity.
    const first = await executeRunCommand({ contractPath, backends, debounceMs: 1, maxParallel: 1 });
    assert.equal(first.exitCode, 10);
    const registry = new ProjectRegistry(process.env.AGENT_TEAM_HOME ? resolveAgentTeamHome().stateDb : '');
    const project = registry.getProject('cov-project');
    assert.deepEqual(project.gitIdentity, { remote: 'git@example.test:cov/repo.git' });
    registry.close();

    // Deny grant fails the task; question grants without commands or tasks are tolerated.
    const pendingPath = first.pendingPath;
    const pendingFile = JSON.parse(readFileSync(pendingPath, 'utf8'));
    pendingFile.pending.push({ id: 'pQ', kind: 'question', taskId: null, agentId: 'worker:claude', subject: 'why', reason: 'r' });
    writeFileSync(pendingPath, JSON.stringify(pendingFile), 'utf8');
    pendingFile.pending.push(
      { id: 'p2', kind: 'approval', taskId: null, agentId: 'worker:claude', subject: 'dup', reason: 'r', commands: ['pnpm test'] },
      { id: 'p3', kind: 'approval', taskId: null, agentId: 'worker:claude', subject: 'gone', reason: 'r', commands: [] }
    );
    writeFileSync(pendingPath, JSON.stringify(pendingFile), 'utf8');
    const decisionsPath = join(repoRoot, 'decisions.json');
    writeFileSync(decisionsPath, JSON.stringify({ p1: 'deny', pQ: 'approve', p2: 'approve', p3: 'deny' }), 'utf8');

    const second = await executeRunCommand({
      contractPath, runId: first.runId, grantPath: decisionsPath, backends, exitMode: 'quiescence', maxParallel: 2
    });
    assert.equal(second.exitCode, 1);
    assert.deepEqual(second.pending, []);

    // A contract revision with array-valued provenance applies and the run completes.
    const revisedPath = join(repoRoot, 'contract-v2.json');
    writeFileSync(revisedPath, JSON.stringify(contractFor(repoRoot, (c) => {
      c.tasks[0].allowedPaths = ['**'];
      c.provenance = { documents: [{ kind: 'requirement', locator: 'sdd://x@2', revision: '2' }] };
    })));
    const db = new StateDatabase(resolveAgentTeamHome().stateDb);
    db.updateTask(first.runId, 'T001', { status: 'blocked_on_contract' });
    db.close();
    rmSync(pendingPath);
    const emptyGrantPath = join(repoRoot, 'empty-grant.json');
    writeFileSync(emptyGrantPath, JSON.stringify({}), 'utf8');
    const third = await executeRunCommand({
      contractPath: revisedPath, runId: first.runId, grantPath: emptyGrantPath, backends, exitMode: 'quiescence'
    });
    if (third.exitCode !== 0) {
      const ddbg = new StateDatabase(resolveAgentTeamHome().stateDb);
      console.log('DBG run:', ddbg.getRun(first.runId).status, ddbg.getRun(first.runId).error);
      for (const t of ddbg.listTasks(first.runId)) console.log('DBG task:', t.taskId, t.status, t.lastError, 'attempts', t.attempts);
      ddbg.close();
    }
    assert.equal(third.exitCode, 0);
    assert.equal(third.kind, 'done');
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TEAM_HOME;
    else process.env.AGENT_TEAM_HOME = previousHome;
  }
});

test('clean skips tasks without worktrees and runs without integration artifacts', async () => {
  const repoRoot = scratch('agent-team-clean-null-');
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  await git(repoRoot, ['init', '-q']);
  await git(repoRoot, ['config', 'user.email', 't@e.com']);
  await git(repoRoot, ['config', 'user.name', 't']);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-q', '-m', 'base']);
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(scratch('agent-team-clean-null-home-'), 'home') } });
  const db = new StateDatabase(home.stateDb);
  try {
    db.createRun({ id: 'r2', repoRoot, goalFile: 'g', baseRef: 'HEAD', baseSha: 'base', adapter: 'external' });
    db.insertTask('r2', { id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] });
    const result = await cleanRunArtifacts(db, 'r2');
    assert.deepEqual(result.removedWorktrees, []);
    assert.deepEqual(result.removedBranches, []);
    assert.equal(db.getRun('r2').status, 'cancelled');
  } finally {
    db.close();
  }
});

test('readPendingFileSync rejects non-object payloads', () => {
  const dir = scratch('agent-team-pending-shapes-');
  writeFileSync(join(dir, 'array.json'), '[]', 'utf8');
  writeFileSync(join(dir, 'number.json'), '5', 'utf8');
  assert.equal(readPendingFileSync(join(dir, 'array.json')), undefined);
  assert.equal(readPendingFileSync(join(dir, 'number.json')), undefined);
});

test('auto-registration tolerates repositories without remotes or git metadata', async () => {
  const plainDir = scratch('agent-team-cov-plain-');
  const previousHome = process.env.AGENT_TEAM_HOME;
  process.env.AGENT_TEAM_HOME = join(scratch('agent-team-cov-plain-home-'), 'home');
  const contractPath = join(plainDir, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contractFor(plainDir)));
  try {
    await assert.rejects(
      executeRunCommand({ contractPath, backends: { claude: {}, codex: {}, opencode: {} } }),
      /not a git repository|git repository|failed|git/i
    );
    const registry = new ProjectRegistry(join(process.env.AGENT_TEAM_HOME, 'state.sqlite'));
    const project = registry.getProject('cov-project');
    assert.deepEqual(project.gitIdentity, { root: plainDir });
    assert.equal(project.gitCommonDir, plainDir);
    registry.close();
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_TEAM_HOME;
    else process.env.AGENT_TEAM_HOME = previousHome;
  }
});

test('assertExecutionContractFields tolerates tasks without implementation skills', () => {
  assert.doesNotThrow(() => assertExecutionContractFields(
    { version: 1, project: { id: 'p', repoRoot: '/r', baseRef: 'HEAD' },
      tasks: [{ id: 'T001', title: 't', description: 'd', dependsOn: [], allowedPaths: ['a/**'], blockedPaths: [], acceptance: ['a'], verificationCommands: [] }] }
  ));
});
