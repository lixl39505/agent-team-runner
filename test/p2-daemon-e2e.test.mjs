import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { test } from 'vitest';
import { FakeBackend } from '../src/agent/fake.ts';
import { runOrchestrator } from '../src/core/orchestrator.ts';
import { resolveAgentTeamHome } from '../src/core/home.ts';
import { LocalIpcClient } from '../src/daemon/ipc.ts';
import { AgentTeamDaemon, connectToDaemon } from '../src/daemon/service.ts';
import { createMcpServer } from '../src/mcp/server.ts';

function repository(parent) {
  const repoRoot = mkdtempSync(join(parent, 'repo-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'README.md'), '# P2 end-to-end test\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Tests'], { cwd: repoRoot });
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repoRoot });
  return {
    repoRoot,
    gitCommonDir: resolve(repoRoot, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim())
  };
}

function projectPolicy() {
  return {
    baseRef: 'HEAD',
    verificationAllowedCommandPrefixes: ['npm test'],
    baselinePathPolicy: { allowed: ['src/**'] },
    agentProfileMapping: {
      defaultAgent: 'claude-worker',
      agents: {
        'claude-worker': { backend: 'claude' },
        'opencode-worker': { backend: 'opencode' },
        reviewer: { backend: 'codex' },
        integrator: { backend: 'codex' }
      },
      roles: { worker: 'claude-worker', reviewer: 'reviewer', integrator: 'integrator' }
    },
    backendPolicy: { concurrency: 1 }
  };
}

function contract(project, repoRoot, overrides = {}) {
  return {
    version: 1,
    project: { id: project.id, repoRoot, baseRef: 'HEAD' },
    target: { integrationBranch: 'agent-team/p2-acceptance' },
    provenance: { documents: [{ kind: 'spec', locator: 'p2.md', revision: 'p2' }] },
    tasks: [
      {
        id: 'T001', title: 'First change', description: 'Create the first file.', role: 'worker', agent: 'claude-worker',
        dependsOn: [], allowedPaths: ['src/one.txt'], blockedPaths: [], acceptance: ['first file exists'], verificationCommands: []
      },
      {
        id: 'T002', title: 'Dependent change', description: 'Create the dependent file.', role: 'worker', agent: 'opencode-worker',
        dependsOn: ['T001'], allowedPaths: ['src/two.txt'], blockedPaths: [], acceptance: ['second file exists'], verificationCommands: []
      }
    ],
    ...overrides
  };
}

function workerOutput() {
  return { status: 'completed', summary: 'completed by fake backend', testsRun: [], knownRisks: [] };
}

function reviewOutput() {
  return { decision: 'approved', summary: 'approved by fake backend', findings: [], requiredChanges: [] };
}

class WritingFakeBackend extends FakeBackend {
  constructor(id, output, onSession) {
    super({ output }, [], id);
    this.specs = [];
    this.onSession = onSession;
  }

  async openSession(spec) {
    this.specs.push(spec);
    this.onSession?.(spec);
    return await super.openSession(spec);
  }
}

function fakePool() {
  const claude = new WritingFakeBackend('claude', workerOutput(), (spec) => {
    if (spec.role === 'worker') {
      mkdirSync(join(spec.cwd, 'src'), { recursive: true });
      writeFileSync(join(spec.cwd, 'src', 'one.txt'), 'one\n', 'utf8');
    }
  });
  const opencode = new WritingFakeBackend('opencode', workerOutput(), (spec) => {
    if (spec.role !== 'worker') return;
    assert.equal(readFileSync(join(spec.cwd, 'src', 'one.txt'), 'utf8'), 'one\n');
    mkdirSync(join(spec.cwd, 'src'), { recursive: true });
    writeFileSync(join(spec.cwd, 'src', 'two.txt'), 'two\n', 'utf8');
  });
  const codex = new WritingFakeBackend('codex', reviewOutput());
  return { claude, codex, opencode };
}

async function waitFor(check, label = 'condition') {
  for (let attempts = 0; attempts < 200; attempts += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function connectMcp(ipc) {
  const server = createMcpServer(ipc, { pollIntervalMs: 5 });
  const client = new Client({ name: 'p2-e2e', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

async function closeMcp(connection, ipc) {
  await connection.server.close();
  // The gateway releases controller leases over IPC from its asynchronous close hook.
  await new Promise((resolve) => setTimeout(resolve, 20));
  ipc.close();
}

function toolResult(result) {
  assert.equal(result.isError, undefined);
  return result.structuredContent.result;
}

test('P2 end-to-end: daemon IPC and MCP preserve a DAG, target integration branch, handoff, and controller reconnect', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-team-p2-e2e-'));
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  const { repoRoot, gitCommonDir } = repository(parent);
  const pool = fakePool();
  const daemon = new AgentTeamDaemon(home, {
    runExecutor: async (input) => runOrchestrator({ ...input, backends: pool })
  });
  let first;
  let second;
  let firstIpc;
  let secondIpc;
  try {
    await daemon.start();
    const duplicate = new AgentTeamDaemon(home);
    try {
      await assert.rejects(duplicate.start(), /already running/);
    } finally {
      await duplicate.stop();
    }

    firstIpc = await connectToDaemon(home);
    first = await connectMcp(firstIpc);
    const project = toolResult(await first.client.callTool({
      name: 'agent_team_register_project',
      arguments: { gitCommonDir, repoRoot, displayName: 'P2 E2E repository', gitIdentity: {}, policy: projectPolicy() }
    }));
    const executionContract = contract(project, repoRoot);
    assert.deepEqual(toolResult(await first.client.callTool({
      name: 'agent_team_submit_execution_contract', arguments: { contract: executionContract, runId: 'p2-e2e' }
    })), { runId: 'p2-e2e', scheduled: true });
    const attached = toolResult(await first.client.callTool({
      name: 'agent_team_attach_controller',
      arguments: { runId: 'p2-e2e', host: 'p2-host', externalThreadId: 'thread-1', clientId: 'p2-client-1' }
    }));
    assert.equal(attached.execution.contract.target.integrationBranch, 'agent-team/p2-acceptance');

    await closeMcp(first, firstIpc);
    first = undefined;
    firstIpc = undefined;
    await waitFor(
      () => daemon.controlPlaneStore.getController('p2-e2e').status === 'disconnected',
      'MCP controller detach'
    );

    secondIpc = await connectToDaemon(home);
    second = await connectMcp(secondIpc);
    const reattached = toolResult(await second.client.callTool({
      name: 'agent_team_attach_controller',
      arguments: { runId: 'p2-e2e', host: 'p2-host', externalThreadId: 'thread-2', clientId: 'p2-client-2', lastAckEventId: 0 }
    }));
    assert.equal(reattached.externalThreadId, 'thread-2');
    await waitFor(() => {
      const run = daemon.stateDatabase.getRun('p2-e2e');
      if (!['planned', 'running', 'integrating', 'done'].includes(run.status)) {
        throw new Error(`fake DAG stopped at ${run.status}: ${run.error}`);
      }
      return run.status === 'done';
    }, 'fake DAG completion');

    const handoff = toolResult(await second.client.callTool({
      name: 'agent_team_get_handoff', arguments: { runId: 'p2-e2e' }
    }));
    assert.equal(handoff.run.integrationBranch, 'agent-team/p2-acceptance');
    assert.equal(handoff.run.status, 'done');
    assert.deepEqual(handoff.contract, executionContract);
    assert.deepEqual(handoff.tasks.map((task) => [task.id, task.status]), [['T001', 'approved'], ['T002', 'approved']]);
    assert.equal(daemon.stateDatabase.getRun('p2-e2e').integrationBranch, 'agent-team/p2-acceptance');
    assert.equal(readFileSync(join(daemon.stateDatabase.getRun('p2-e2e').integrationWorktree, 'src', 'one.txt'), 'utf8'), 'one\n');
    assert.equal(readFileSync(join(daemon.stateDatabase.getRun('p2-e2e').integrationWorktree, 'src', 'two.txt'), 'utf8'), 'two\n');
    assert.deepEqual([pool.claude.specs.length, pool.codex.specs.length, pool.opencode.specs.length], [1, 2, 1]);
  } finally {
    if (second && secondIpc) await closeMcp(second, secondIpc);
    if (first && firstIpc) await closeMcp(first, firstIpc);
    await daemon.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});

test('P2 end-to-end: daemon restart recovers an interrupted fake-backed run from durable state', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-team-p2-recovery-'));
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  const { repoRoot, gitCommonDir } = repository(parent);
  const firstWorker = new WritingFakeBackend('claude', workerOutput(), (spec) => {
    if (spec.role === 'worker') {
      mkdirSync(join(spec.cwd, 'src'), { recursive: true });
      writeFileSync(join(spec.cwd, 'src', 'recovered.txt'), 'interrupted\n', 'utf8');
    }
  });
  firstWorker.script = { silent: true };
  const firstPool = {
    claude: firstWorker,
    codex: new WritingFakeBackend('codex', reviewOutput()),
    opencode: new WritingFakeBackend('opencode', workerOutput())
  };
  const recoveredPool = fakePool();
  const recoveryContract = contract({ id: 'unused' }, repoRoot, {
    target: { integrationBranch: 'agent-team/p2-recovered' },
    tasks: [{
      id: 'T001', title: 'Recover change', description: 'Create a recovered file.', role: 'worker', agent: 'claude-worker',
      dependsOn: [], allowedPaths: ['src/one.txt'], blockedPaths: [], acceptance: ['recovered file exists'], verificationCommands: []
    }]
  });
  const firstDaemon = new AgentTeamDaemon(home, {
    runExecutor: async (input) => runOrchestrator({ ...input, backends: firstPool })
  });
  let secondDaemon;
  let client;
  try {
    await firstDaemon.start();
    client = new LocalIpcClient(home.socket);
    await client.connect();
    const project = await client.request('project.register', {
      gitCommonDir, repoRoot, displayName: 'P2 recovery repository', gitIdentity: {}, policy: projectPolicy()
    });
    recoveryContract.project.id = project.id;
    await client.request('execution.submit', { contract: recoveryContract, runId: 'p2-recovery' });
    await waitFor(() => firstWorker.specs.length === 1, 'interrupted worker start');
    client.close();
    client = undefined;
    await firstDaemon.stop();

    secondDaemon = new AgentTeamDaemon(home, {
      runExecutor: async (input) => runOrchestrator({ ...input, backends: recoveredPool })
    });
    await secondDaemon.start();
    await waitFor(() => {
      const run = secondDaemon.stateDatabase.getRun('p2-recovery');
      if (!['planned', 'running', 'integrating', 'done'].includes(run.status)) {
        throw new Error(`recovered run stopped at ${run.status}: ${run.error}`);
      }
      return run.status === 'done';
    }, 'recovered run completion');
    assert.equal(secondDaemon.stateDatabase.getRun('p2-recovery').integrationBranch, 'agent-team/p2-recovered');
    assert.equal(readFileSync(join(secondDaemon.stateDatabase.getRun('p2-recovery').integrationWorktree, 'src', 'one.txt'), 'utf8'), 'one\n');
    assert.equal(secondDaemon.stateDatabase.getTask('p2-recovery', 'T001').attempts, 1);
    assert.equal(recoveredPool.claude.specs.length, 1);
    assert.ok(secondDaemon.stateDatabase.listEvents('p2-recovery').some((event) => event.eventType === 'RUN_INTERRUPTED'));
  } finally {
    client?.close();
    await secondDaemon?.stop();
    await firstDaemon.stop();
    assert.equal(existsSync(home.daemonLock), false);
    rmSync(parent, { recursive: true, force: true });
  }
});
