import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { StateDatabase } from '../src/core/db.ts';
import { createExecutionRun } from '../src/core/execution-run.ts';
import { resolveAgentTeamHome } from '../src/core/home.ts';
import { ProjectRegistry } from '../src/core/project-registry.ts';
import { runnerConfigFromProjectPolicy } from '../src/core/project-runtime.ts';
import { ControlPlaneStore } from '../src/daemon/control-plane-store.ts';
import { DaemonAlreadyRunningError } from '../src/daemon/instance-lock.ts';
import { LocalIpcClient } from '../src/daemon/ipc.ts';
import { AgentTeamDaemon, connectToDaemon } from '../src/daemon/service.ts';

async function withHome(run) {
  const parent = await mkdtemp(join(tmpdir(), 'agent-team-daemon-service-'));
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  try {
    await run(home);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function waitFor(check) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for daemon shutdown');
}

async function repository(parent) {
  const repoRoot = await mkdtemp(join(parent, 'repo-'));
  await writeFile(join(repoRoot, 'README.md'), '# Test\n', 'utf8');
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
      defaultAgent: 'lead',
      agents: { lead: { backend: 'codex' } },
      roles: { lead: 'lead' }
    },
    backendPolicy: {}
  };
}

function executionContract(project, repoRoot) {
  return {
    version: 1,
    project: { id: project.id, repoRoot, baseRef: 'HEAD' },
    target: { integrationBranch: 'agent-team/integration' },
    provenance: { documents: [{ kind: 'spec', locator: 'spec.md', revision: 'abc123' }] },
    tasks: [{
      id: 'T001',
      externalId: 'SPEC-1',
      title: 'Create feature',
      description: 'Implement the feature.',
      role: 'worker',
      agent: 'lead',
      dependsOn: [],
      allowedPaths: ['src/**'],
      blockedPaths: ['docs/**'],
      acceptance: ['feature works'],
      verificationCommands: ['npm test'],
      implementationSkills: [{ name: 'test-skill', role: 'worker', required: false, source: 'project' }],
      implementationGuidance: ['Write tests first.'],
      allowNoChanges: false
    }]
  };
}

function eventTypes(db, runId) {
  return db.db.prepare('SELECT event_type FROM events WHERE run_id = ? ORDER BY id').all(runId).map((entry) => entry.event_type);
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test('AgentTeamDaemon starts and reports health metadata', async () => {
  await withHome(async (home) => {
    const daemon = new AgentTeamDaemon(home, { protocolVersion: 7 });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const health = await client.request('health');
      assert.equal(health.home, home.root);
      assert.equal(health.protocolVersion, 7);
      assert.equal(health.metadata.pid, process.pid);
      assert.equal(health.metadata.protocolVersion, 7);
      assert.ok(Date.parse(health.metadata.startedAt));
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon stop is idempotent', async () => {
  await withHome(async (home) => {
    const daemon = new AgentTeamDaemon(home);
    await daemon.start();
    await daemon.start();
    await Promise.all([daemon.stop(), daemon.stop()]);
    await daemon.stop();
    assert.equal(existsSync(home.daemonLock), false);
    assert.equal(existsSync(home.daemonInfo), false);
    assert.equal(existsSync(home.socket), false);
  });
});

test('AgentTeamDaemon accepts shutdown requests before stopping', async () => {
  await withHome(async (home) => {
    const daemon = new AgentTeamDaemon(home);
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      assert.deepEqual(await client.request('shutdown'), { accepted: true });
      await waitFor(() => !existsSync(home.daemonLock));
      assert.equal(existsSync(home.socket), false);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon propagates an active daemon lock', async () => {
  await withHome(async (home) => {
    const first = new AgentTeamDaemon(home);
    const second = new AgentTeamDaemon(home);
    await first.start();
    try {
      await assert.rejects(second.start(), DaemonAlreadyRunningError);
    } finally {
      await first.stop();
      await second.stop();
    }
  });
});

test('AgentTeamDaemon releases its lock when IPC startup fails', async () => {
  await withHome(async (home) => {
    const server = {
      register() {},
      async start() { throw new Error('IPC startup failed'); },
      async stop() {}
    };
    const daemon = new AgentTeamDaemon(home, { server });
    await assert.rejects(daemon.start(), /IPC startup failed/);
    assert.equal(existsSync(home.daemonLock), false);
    assert.equal(existsSync(home.daemonInfo), false);
  });
});

test('AgentTeamDaemon exposes control-plane operations through LocalIpcClient', async () => {
  await withHome(async (home) => {
    const store = new ControlPlaneStore(home.stateDb);
    const daemon = new AgentTeamDaemon(home, { controlPlaneStore: store });
    const interaction = store.queueInteraction({
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      kind: 'approval',
      request: { command: 'npm test' }
    });
    const requeued = store.queueInteraction({
      runId: 'run-2',
      agentId: 'agent-2',
      kind: 'agent_question',
      request: { question: 'Continue?' }
    });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      assert.deepEqual(
        (await client.request('interaction.list')).map((entry) => entry.id).sort(),
        [interaction.id, requeued.id].sort()
      );
      assert.deepEqual((await client.request('interaction.list', { runId: 'run-1' })).map((entry) => entry.id), [interaction.id]);
      assert.equal((await client.request('interaction.claim', { id: interaction.id, clientId: 'client-a' })).status, 'claimed');
      const answered = await client.request('interaction.answer', {
        id: interaction.id, clientId: 'client-a', response: { approved: true }
      });
      assert.equal(answered.status, 'resolved');
      assert.deepEqual(answered.response, { approved: true });
      assert.equal(answered.claimedByClientId, 'client-a');

      await client.request('interaction.claim', { id: requeued.id, clientId: 'client-a' });
      assert.equal(await client.request('interaction.requeue_client', { clientId: 'client-a' }), 1);

      const attached = await client.request('controller.attach', { runId: 'run-1', host: 'host-a', clientId: 'client-a' });
      assert.equal(attached.externalThreadId, 'run-1');
      assert.equal(attached.status, 'connected');
      assert.equal(attached.lastAckEventId, null);
      assert.ok(Date.parse(attached.claimedAt));
      assert.equal(
        (await client.request('controller.attach', {
          runId: 'run-1', host: 'host-b', externalThreadId: 'thread-1', clientId: 'client-a', lastAckEventId: 7
        })).lastAckEventId,
        7
      );
      assert.equal(
        (await client.request('controller.attach', {
          runId: 'run-2', host: 'host-a', externalThreadId: 'thread-2', clientId: 'client-a', lastAckEventId: null
        })).lastAckEventId,
        null
      );
      const disconnected = await client.request('controller.disconnect', { runId: 'run-1', clientId: 'client-a' });
      assert.equal(disconnected.status, 'disconnected');
      assert.deepEqual(await client.request('controller.reconnectable'), [disconnected]);

      await assert.rejects(client.request('interaction.list', null), /params must be an object/);
      await assert.rejects(client.request('interaction.list', []), /params must be an object/);
      await assert.rejects(client.request('interaction.list', { unexpected: true }), /unknown field/);
      await assert.rejects(client.request('interaction.claim', { id: interaction.id }), /clientId/);
      await assert.rejects(client.request('interaction.claim', { id: '', clientId: 'client-a' }), /id/);
      await assert.rejects(client.request('interaction.list', { runId: 1 }), /runId/);
      await assert.rejects(client.request('interaction.answer', { id: interaction.id, clientId: 'client-a' }), /response/);
      await assert.rejects(client.request('controller.attach', { runId: 'run-2', host: 'host-a', clientId: 'client-a', lastAckEventId: -1 }), /lastAckEventId/);
      await assert.rejects(client.request('controller.reconnectable', {}), /does not accept params/);
    } finally {
      client.close();
      await daemon.stop();
      assert.deepEqual(store.listInteractions('run-1').map((entry) => entry.id), [interaction.id]);
      store.close();
    }
  });
});

test('AgentTeamDaemon reads durable events with explicit controller acknowledgements', async () => {
  await withHome(async (home) => {
    const daemon = new AgentTeamDaemon(home);
    daemon.stateDatabase.createRun({
      id: 'event-run', repoRoot: '/repo', goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'external'
    });
    daemon.stateDatabase.addEvent('event-run', 'T001', 'JSON_EVENT', { value: true });
    daemon.stateDatabase.addEvent('event-run', null, 'NULL_EVENT', null);
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      await assert.rejects(client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a'
      }), /controller not found/);

      await client.request('controller.attach', {
        runId: 'event-run', host: 'host', externalThreadId: 'thread', clientId: 'client-a'
      });
      const initial = await client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a', limit: 1
      });
      assert.equal(initial.events[0].eventType, 'RUN_CREATED');
      const first = await client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a', afterEventId: 0, limit: 2
      });
      assert.deepEqual(first.events.map((event) => event.eventType), ['RUN_CREATED', 'JSON_EVENT']);
      assert.deepEqual(first.events[1].payload, { value: true });
      assert.equal(first.lastEventId, first.events[1].id);

      const next = await client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a', afterEventId: first.lastEventId, limit: 1
      });
      assert.deepEqual(next.events.map((event) => ({ type: event.eventType, payload: event.payload })), [
        { type: 'NULL_EVENT', payload: null }
      ]);
      const unacknowledged = await client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a', limit: 1
      });
      assert.equal(unacknowledged.events[0].id, next.events[0].id);

      await client.request('controller.disconnect', { runId: 'event-run', clientId: 'client-a' });
      const reconnected = await client.request('controller.attach', {
        runId: 'event-run', host: 'host', externalThreadId: 'thread', clientId: 'client-a'
      });
      assert.equal(reconnected.lastAckEventId, first.lastEventId);
      const resumed = await client.request('execution.events', { runId: 'event-run', clientId: 'client-a', limit: 1 });
      assert.equal(resumed.events[0].id, next.events[0].id);
      const empty = await client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a', afterEventId: resumed.lastEventId
      });
      assert.deepEqual(empty, { events: [], lastEventId: resumed.lastEventId });

      await assert.rejects(client.request('execution.events', {
        runId: 'event-run', clientId: 'client-b'
      }), /not owned/);
      await assert.rejects(client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a', afterEventId: -1
      }), /afterEventId/);
      await assert.rejects(client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a', limit: 0
      }), /limit/);
      await assert.rejects(client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a', limit: 1001
      }), /limit/);
      await assert.rejects(client.request('execution.events', {
        runId: 'event-run', clientId: 'client-a', unexpected: true
      }), /unknown field/);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon registers projects and materializes execution contracts through IPC', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const executorInputs = [];
    const daemon = new AgentTeamDaemon(home, { runExecutor: async (input) => { executorInputs.push(input); } });
    const observer = new StateDatabase(home.stateDb);
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir,
        repoRoot,
        displayName: 'Daemon test repository',
        gitIdentity: { remote: 'git@example.test:daemon/test.git' },
        policy: projectPolicy()
      });
      assert.match(project.id, /^project-/);
      assert.deepEqual((await client.request('project.list')).map((entry) => entry.id), [project.id]);

      const submitted = await client.request('execution.submit', {
        contract: executionContract(project, repoRoot),
        runId: 'daemon-execution'
      });
      assert.deepEqual(submitted, { runId: 'daemon-execution', scheduled: true });
      await waitFor(() => executorInputs.length === 1);
      assert.equal(observer.getRun(submitted.runId).status, 'planned');
      assert.equal(observer.getRun(submitted.runId).projectPolicyRevisionId, project.currentPolicyRevisionId);
      assert.equal(observer.listTasks(submitted.runId).length, 1);

      const execution = await client.request('execution.get', { runId: submitted.runId });
      assert.equal(execution.run.status, 'planned');
      assert.equal(execution.run.repoRoot, repoRoot);
      assert.deepEqual(execution.tasks.map((task) => task.taskId), ['T001']);
      assert.deepEqual(execution.agentExecutions, []);

      const generatedContract = executionContract(project, repoRoot);
      delete generatedContract.provenance;
      delete generatedContract.tasks[0].implementationSkills;
      const generated = await client.request('execution.submit', { contract: generatedContract });
      assert.match(generated.runId, /^execution-/);
      assert.equal(generated.scheduled, true);
      await waitFor(() => executorInputs.length === 2);

      await assert.rejects(client.request('project.register', { unexpected: true }), /unknown field/);
      await assert.rejects(client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Bad policy', gitIdentity: {},
        policy: { ...projectPolicy(), unexpected: true }
      }), /policy contains unknown field/);
      await assert.rejects(client.request('project.list', {}), /does not accept params/);
      await assert.rejects(client.request('execution.submit', { contract: executionContract({ id: 'missing' }, repoRoot) }), /Project not found: missing/);
      await assert.rejects(client.request('execution.submit', { contract: executionContract(project, repoRoot), runId: 1 }), /runId/);
      await assert.rejects(client.request('execution.submit', {
        contract: { ...executionContract(project, repoRoot), unexpected: true }
      }), /unknown field/);
      await assert.rejects(client.request('execution.get', { runId: submitted.runId, unexpected: true }), /unknown field/);
      await assert.rejects(client.request('execution.get', { runId: '' }), /runId/);
    } finally {
      client.close();
      await daemon.stop();
      observer.close();
    }
  });
});

test('AgentTeamDaemon execution.start does not schedule an already active run', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const release = deferred();
    let executions = 0;
    const daemon = new AgentTeamDaemon(home, {
      runExecutor: async () => { executions += 1; await release.promise; }
    });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Active execution', gitIdentity: {}, policy: projectPolicy()
      });
      const submitted = await client.request('execution.submit', {
        contract: executionContract(project, repoRoot), runId: 'active-execution'
      });
      assert.equal(submitted.scheduled, true);
      assert.deepEqual(await client.request('execution.start', { runId: submitted.runId }), {
        runId: submitted.runId, scheduled: false
      });
      await waitFor(() => executions === 1);
    } finally {
      release.resolve();
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon cancels active and planned runs through IPC', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const aborted = deferred();
    let executorStarted = false;
    const daemon = new AgentTeamDaemon(home, {
      runExecutor: async (input) => {
        executorStarted = true;
        await new Promise((resolve) => input.signal.addEventListener('abort', resolve, { once: true }));
        aborted.resolve();
      }
    });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Cancellable execution', gitIdentity: {}, policy: projectPolicy()
      });
      await client.request('execution.submit', {
        contract: executionContract(project, repoRoot), runId: 'active-cancellation'
      });
      await waitFor(() => executorStarted);
      assert.deepEqual(await client.request('execution.cancel', { runId: 'active-cancellation' }), {
        runId: 'active-cancellation', cancelled: true
      });
      await aborted.promise;
      assert.equal(daemon.stateDatabase.getRun('active-cancellation').status, 'needs_attention');
      assert.equal(daemon.stateDatabase.getRun('active-cancellation').error, 'Cancelled by controller; run again to resume.');
      assert.equal(eventTypes(daemon.stateDatabase, 'active-cancellation').filter((type) => type === 'RUN_CANCELLED').length, 1);

      daemon.stateDatabase.createRun({
        id: 'planned-cancellation', repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'external'
      });
      daemon.stateDatabase.updateRun('planned-cancellation', { status: 'planned' });
      assert.deepEqual(await client.request('execution.cancel', { runId: 'planned-cancellation' }), {
        runId: 'planned-cancellation', cancelled: true
      });
      assert.equal(daemon.stateDatabase.getRun('planned-cancellation').status, 'needs_attention');
      assert.equal(daemon.stateDatabase.getRun('planned-cancellation').error, 'Cancelled by controller; run again to resume.');
      assert.equal(eventTypes(daemon.stateDatabase, 'planned-cancellation').filter((type) => type === 'RUN_CANCELLED').length, 1);
      await client.request('execution.cancel', { runId: 'planned-cancellation' });
      assert.equal(eventTypes(daemon.stateDatabase, 'planned-cancellation').filter((type) => type === 'RUN_CANCELLED').length, 1);

      daemon.stateDatabase.createRun({
        id: 'completed-cancellation', repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'external'
      });
      daemon.stateDatabase.updateRun('completed-cancellation', { status: 'done' });
      await assert.rejects(client.request('execution.cancel', { runId: 'completed-cancellation' }), /cannot be cancelled/);
      await assert.rejects(client.request('execution.cancel', { runId: '', unexpected: true }), /runId|unknown field/);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon aborts active runs and waits before closing the state database', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const aborted = deferred();
    const release = deferred();
    let executorStarted = false;
    let databaseWasOpen = false;
    const daemon = new AgentTeamDaemon(home, {
      runExecutor: async (input) => {
        executorStarted = true;
        await new Promise((resolve) => input.signal.addEventListener('abort', resolve, { once: true }));
        aborted.resolve();
        await release.promise;
        input.db.updateRun(input.runId, { status: 'needs_attention' });
        databaseWasOpen = true;
      }
    });
    const stateDatabase = daemon.stateDatabase;
    let stateDatabaseClosed = false;
    const closeStateDatabase = stateDatabase.close.bind(stateDatabase);
    stateDatabase.close = () => {
      stateDatabaseClosed = true;
      closeStateDatabase();
    };
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Stopping execution', gitIdentity: {}, policy: projectPolicy()
      });
      await client.request('execution.submit', {
        contract: executionContract(project, repoRoot), runId: 'stop-cancellation'
      });
      await waitFor(() => executorStarted);
      client.close();
      const stopping = daemon.stop();
      await aborted.promise;
      assert.equal(stateDatabaseClosed, false);
      release.resolve();
      await stopping;
      assert.equal(databaseWasOpen, true);
      assert.equal(stateDatabaseClosed, true);
    } finally {
      release.resolve();
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon recovers persisted planned external runs when restarted', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const registry = new ProjectRegistry(home.stateDb);
    const database = new StateDatabase(home.stateDb);
    const project = registry.registerProject({
      gitCommonDir, repoRoot, displayName: 'Recoverable execution', gitIdentity: {}, policy: projectPolicy()
    });
    const policy = registry.getProjectPolicy(project.id);
    await createExecutionRun({
      config: runnerConfigFromProjectPolicy(policy, project, home),
      db: database,
      contract: executionContract(project, repoRoot),
      projectPolicyRevisionId: policy.id,
      runId: 'recover-planned'
    });
    await createExecutionRun({
      config: runnerConfigFromProjectPolicy(policy, project, home),
      db: database,
      contract: executionContract(project, repoRoot),
      projectPolicyRevisionId: policy.id,
      runId: 'recover-running'
    });
    database.updateRun('recover-running', { status: 'running' });
    database.close();
    registry.close();

    const executorInputs = [];
    const daemon = new AgentTeamDaemon(home, { runExecutor: async (input) => { executorInputs.push(input); } });
    try {
      await daemon.start();
      await waitFor(() => executorInputs.length === 2);
      assert.deepEqual(executorInputs.map((input) => input.runId).sort(), ['recover-planned', 'recover-running']);
      assert.equal(executorInputs[0].config.workspace.repoRoot, repoRoot);
    } finally {
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon persists daemon approval and user-input interactions', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const store = new ControlPlaneStore(home.stateDb);
    const results = [];
    const daemon = new AgentTeamDaemon(home, {
      controlPlaneStore: store,
      runExecutor: async (input) => {
        const approval = input.requestApproval;
        const userInput = input.requestUserInput;
        const common = { backend: 'codex', role: 'worker', cwd: repoRoot, kind: 'tool', tool: 'ask', allowSession: true };
        for (const [index, request] of [
          { ...common, input: { absent: undefined }, sessionId: 'approval-session' },
          { ...common, input: {} },
          { ...common, input: {} },
          { ...common, input: (() => { const value = {}; value.self = value; return value; })() }
        ].entries()) {
          try { results.push(await approval(request, index === 0 ? new AbortController().signal : undefined)); } catch (error) { results.push(String(error)); }
        }
        for (const [index, request] of [
          { backend: 'codex', role: 'worker', cwd: repoRoot, questions: [], sessionId: 'input-session' },
          { backend: 'codex', role: 'worker', cwd: repoRoot, questions: [] },
          { backend: 'codex', role: 'worker', cwd: repoRoot, questions: [] },
          { backend: 'codex', role: 'worker', cwd: repoRoot, questions: [] }
        ].entries()) {
          try { results.push(await userInput(request, index === 0 ? new AbortController().signal : undefined)); } catch (error) { results.push(String(error)); }
        }
      }
    });
    const answerNext = async (count, response) => {
      await waitFor(() => store.listInteractions().length === count);
      const interaction = store.listInteractions().at(-1);
      store.claimInteraction(interaction.id, 'controller');
      store.answerInteraction(interaction.id, 'controller', response);
    };
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Interactive execution', gitIdentity: {}, policy: projectPolicy()
      });
      await client.request('execution.submit', { contract: executionContract(project, repoRoot), runId: 'interactive-execution' });
      await waitFor(() => store.listInteractions().length === 1);
      const first = store.listInteractions()[0];
      assert.equal(first.agentId, 'worker:codex');
      assert.equal(first.taskId, null);
      assert.equal(first.sessionId, 'approval-session');
      assert.equal(first.request.input.absent, null);
      await answerNext(1, 'once');
      await answerNext(2, 'session');
      await answerNext(3, 'deny');
      await answerNext(4, 'invalid');
      assert.equal(store.listInteractions()[3].request, null);
      await answerNext(5, { choice: ['yes'] });
      await answerNext(6, null);
      await answerNext(7, []);
      await answerNext(8, { choice: ['yes', 1] });
      await waitFor(() => results.length === 8);
      assert.deepEqual(results.slice(0, 3), ['once', 'session', 'deny']);
      assert.deepEqual(results[4], { choice: ['yes'] });
      assert.match(results[3], /Invalid approval response/);
      assert.match(results[5], /Invalid user input response/);
      assert.match(results[6], /Invalid user input response/);
      assert.match(results[7], /Invalid user input response/);
      assert.equal(store.listInteractions()[4].sessionId, 'input-session');
      assert.equal(store.listInteractions()[5].sessionId, null);
    } finally {
      client.close();
      await daemon.stop();
      store.close();
    }
  });
});

test('AgentTeamDaemon marks executor failures in the run database', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const daemon = new AgentTeamDaemon(home, {
      runExecutor: async (input) => {
        if (input.runId === 'executor-completed') input.db.updateRun(input.runId, { status: 'done' });
        throw new Error('executor exploded');
      }
    });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Failing execution', gitIdentity: {}, policy: projectPolicy()
      });
      const submitted = await client.request('execution.submit', {
        contract: executionContract(project, repoRoot), runId: 'executor-failure'
      });
      await waitFor(() => daemon.stateDatabase.getRun(submitted.runId).status === 'failed');
      assert.match(daemon.stateDatabase.getRun(submitted.runId).error, /executor exploded/);
      assert.equal(eventTypes(daemon.stateDatabase, submitted.runId).includes('RUN_DAEMON_FAILED'), true);
      const completed = await client.request('execution.submit', {
        contract: executionContract(project, repoRoot), runId: 'executor-completed'
      });
      await waitFor(() => daemon.stateDatabase.getRun(completed.runId).status === 'done');
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(eventTypes(daemon.stateDatabase, completed.runId).includes('RUN_DAEMON_FAILED'), false);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon execution.start rejects terminal and legacy runs', async () => {
  await withHome(async (home) => {
    const daemon = new AgentTeamDaemon(home, { runExecutor: async () => {} });
    daemon.stateDatabase.createRun({
      id: 'legacy-external', repoRoot: '/repo', goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'external'
    });
    daemon.stateDatabase.updateRun('legacy-external', { status: 'planned' });
    daemon.stateDatabase.createRun({
      id: 'non-external', repoRoot: '/repo', goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'cli'
    });
    daemon.stateDatabase.updateRun('non-external', { status: 'planned' });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      await assert.rejects(client.request('execution.start', { runId: 'legacy-external' }), /legacy runs/);
      daemon.stateDatabase.updateRun('legacy-external', { status: 'done' });
      await assert.rejects(client.request('execution.start', { runId: 'legacy-external' }), /cannot be scheduled/);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon closes self-owned project registry and state database exactly once', async () => {
  await withHome(async (home) => {
    const daemon = new AgentTeamDaemon(home);
    const stateDatabase = daemon.stateDatabase;
    const projectRegistry = daemon.projectRegistry;
    let stateDatabaseCloses = 0;
    let projectRegistryCloses = 0;
    const closeStateDatabase = stateDatabase.close.bind(stateDatabase);
    const closeProjectRegistry = projectRegistry.close.bind(projectRegistry);
    stateDatabase.close = () => { stateDatabaseCloses += 1; closeStateDatabase(); };
    projectRegistry.close = () => { projectRegistryCloses += 1; closeProjectRegistry(); };
    await daemon.start();
    await daemon.stop();
    await daemon.stop();
    assert.equal(stateDatabaseCloses, 1);
    assert.equal(projectRegistryCloses, 1);
  });
});

test('AgentTeamDaemon leaves injected project registry and state database open', async () => {
  await withHome(async (home) => {
    const stateDatabase = new StateDatabase(home.stateDb);
    const projectRegistry = new ProjectRegistry(home.stateDb);
    let stateDatabaseCloses = 0;
    let projectRegistryCloses = 0;
    const closeStateDatabase = stateDatabase.close.bind(stateDatabase);
    const closeProjectRegistry = projectRegistry.close.bind(projectRegistry);
    stateDatabase.close = () => { stateDatabaseCloses += 1; closeStateDatabase(); };
    projectRegistry.close = () => { projectRegistryCloses += 1; closeProjectRegistry(); };
    const daemon = new AgentTeamDaemon(home, { stateDatabase, projectRegistry });
    try {
      await daemon.start();
      await daemon.stop();
      assert.equal(stateDatabaseCloses, 0);
      assert.equal(projectRegistryCloses, 0);
      assert.deepEqual(stateDatabase.listRuns(), []);
      assert.deepEqual(projectRegistry.listProjects(), []);
    } finally {
      stateDatabase.close();
      projectRegistry.close();
    }
  });
});

test('AgentTeamDaemon rejects malformed in-memory project and execution IPC values', async () => {
  await withHome(async (home) => {
    const handlers = new Map();
    const server = {
      register(method, handler) { handlers.set(method, handler); },
      async start() {},
      async stop() {}
    };
    const daemon = new AgentTeamDaemon(home, { server });
    const register = handlers.get('project.register');
    const submit = handlers.get('execution.submit');
    const input = {
      gitCommonDir: '/repos/example/.git',
      repoRoot: '/repos/example',
      displayName: 'Example',
      gitIdentity: 1,
      policy: projectPolicy()
    };
    try {
      assert.match((await register(input)).id, /^project-/);
      await assert.rejects(register({ ...input, gitCommonDir: '/repos/non-finite/.git', gitIdentity: Number.NaN }), /JSON value/);
      await assert.rejects(register({ ...input, gitCommonDir: '/repos/missing/.git', gitIdentity: undefined }), /JSON value/);
      await assert.rejects(register({ ...input, gitCommonDir: '/repos/bad-array/.git', policy: { ...projectPolicy(), verificationAllowedCommandPrefixes: [1] } }), /array of strings/);
      await assert.rejects(register({ ...input, gitCommonDir: '/repos/bad-policy/.git', policy: [] }), /policy must be an object/);
      await assert.rejects(submit({}), /contract is required/);
      await assert.rejects(submit({ contract: [] }), /contract must be an object/);
      await assert.rejects(submit({
        contract: {
          version: 1,
          project: { id: 'missing', repoRoot: '/repos/example', baseRef: 'HEAD' },
          target: {},
          provenance: { documents: {} },
          tasks: {}
        }
      }), /Project not found: missing/);
    } finally {
      await daemon.stop();
    }
  });
});

test('connectToDaemon creates and connects a LocalIpcClient', async () => {
  await withHome(async (home) => {
    const daemon = new AgentTeamDaemon(home);
    await daemon.start();
    const client = await connectToDaemon(home);
    try {
      assert.ok(client instanceof LocalIpcClient);
      assert.equal((await client.request('health')).home, home.root);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});
