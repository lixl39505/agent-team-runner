import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
      defaultAgent: 'worker',
      agents: { worker: { backend: 'codex' } },
      roles: { worker: 'worker' }
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
      agent: 'worker',
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
    for (const id of ['run-1', 'run-2']) {
      daemon.stateDatabase.createRun({
        id, repoRoot: '/repo', goalFile: '<test>', baseRef: 'HEAD', baseSha: 'base', adapter: 'test'
      });
    }
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    let foreignInteraction;
    try {
      await client.connect();
      assert.deepEqual(
        (await client.request('interaction.list')).map((entry) => entry.id).sort(),
        [interaction.id, requeued.id].sort()
      );
      assert.deepEqual((await client.request('interaction.list', { runId: 'run-1' })).map((entry) => entry.id), [interaction.id]);
      await client.request('controller.attach', { runId: 'run-1', host: 'host-a', clientId: 'client-a' });
      assert.equal((await client.request('interaction.claim', { id: interaction.id, clientId: 'client-a' })).status, 'claimed');
      const answered = await client.request('interaction.answer', {
        id: interaction.id, clientId: 'client-a', response: { approved: true }, idempotencyKey: 'answer-1'
      });
      assert.equal(answered.status, 'answered');
      assert.deepEqual(answered.response, { approved: true });
      assert.equal(answered.claimedByClientId, 'client-a');
      assert.equal(answered.idempotencyKey, 'answer-1');
      assert.deepEqual(await client.request('interaction.answer', {
        id: interaction.id, clientId: 'client-a', response: { approved: false }, idempotencyKey: 'answer-1'
      }), answered);

      foreignInteraction = store.queueInteraction({
        runId: 'run-1', agentId: 'agent-foreign', kind: 'approval', request: { command: 'npm test' }
      });
      await client.request('interaction.claim', { id: foreignInteraction.id, clientId: 'client-b' });
      await assert.rejects(client.request('interaction.answer', {
        id: foreignInteraction.id, clientId: 'client-b', response: { approved: true }
      }), /not owned/);
      assert.equal(store.getInteraction(foreignInteraction.id).status, 'claimed');

      await client.request('interaction.claim', { id: requeued.id, clientId: 'client-a' });
      assert.equal(await client.request('interaction.requeue_client', { clientId: 'client-a' }), 1);

      const attached = await client.request('controller.attach', { runId: 'run-1', host: 'host-a', clientId: 'client-a' });
      assert.equal(attached.externalThreadId, 'run-1');
      assert.equal(attached.status, 'connected');
      assert.equal(attached.lastAckEventId, null);
      assert.ok(Date.parse(attached.claimedAt));
      assert.equal((await client.request('controller.heartbeat', { runId: 'run-1', clientId: 'client-a' })).status, 'connected');
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
      await assert.rejects(client.request('controller.heartbeat', { runId: 'run-1', clientId: 'client-b' }), /not owned/);
      await assert.rejects(client.request('controller.attach', { runId: 'run-2', host: 'host-a', clientId: 'client-a', lastAckEventId: -1 }), /lastAckEventId/);
      await assert.rejects(client.request('controller.reconnectable', { unexpected: true }), /unknown field/);
    } finally {
      client.close();
      await daemon.stop();
      assert.deepEqual(store.listInteractions('run-1').map((entry) => entry.id).sort(), [
        interaction.id, foreignInteraction.id
      ].sort());
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

test('AgentTeamDaemon reads bounded agent log tails only from managed recorded paths', async () => {
  await withHome(async (home) => {
    const daemon = new AgentTeamDaemon(home);
    const runId = 'log-run';
    const logPath = join(home.runsDir, runId, 'logs', 'agent.log');
    const missingPath = join(home.runsDir, runId, 'logs', 'missing.log');
    const directoryPath = join(home.runsDir, runId, 'logs', 'directory');
    const outsidePath = join(home.root, 'outside.log');
    const escapedPath = join(home.runsDir, runId, 'logs', 'escaped.log');
    daemon.stateDatabase.createRun({
      id: runId, repoRoot: '/repo', goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'test'
    });
    await mkdir(dirname(logPath), { recursive: true });
    await mkdir(directoryPath);
    await writeFile(logPath, 'one\ntwo\nthree\n', 'utf8');
    await writeFile(outsidePath, 'outside\n', 'utf8');
    await symlink(outsidePath, escapedPath);
    for (const [agentId, recordedPath] of [
      ['agent', logPath],
      ['missing', missingPath],
      ['directory', directoryPath],
      ['escaped', escapedPath],
      ['outside', outsidePath]
    ]) {
      daemon.stateDatabase.startAgentExecution({ runId, agentId, role: 'worker', backend: 'codex', logPath: recordedPath });
    }
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      assert.deepEqual(await client.request('execution.agent_log', { runId, agentId: 'agent', maxLines: 2, maxBytes: 1024 }), {
        runId, agentId: 'agent', content: 'two\nthree', lineCount: 2, byteCount: 14, truncated: true
      });
      const byteLimited = await client.request('execution.agent_log', { runId, agentId: 'agent', maxBytes: 8 });
      assert.equal(byteLimited.byteCount, 8);
      assert.equal(byteLimited.truncated, true);
      assert.match(byteLimited.content, /three$/);

      await assert.rejects(client.request('execution.agent_log', { runId, agentId: 'missing' }), /does not exist: log-run\/missing/);
      await assert.rejects(client.request('execution.agent_log', { runId, agentId: 'directory' }), /not readable: log-run\/directory.*regular file/);
      await assert.rejects(client.request('execution.agent_log', { runId, agentId: 'escaped' }), /outside the managed run directory/);
      await assert.rejects(client.request('execution.agent_log', { runId, agentId: 'outside' }), /outside the managed run directory/);
      await assert.rejects(client.request('execution.agent_log', { runId, agentId: 'unknown' }), /not recorded: log-run\/unknown/);
      await assert.rejects(client.request('execution.agent_log', { runId, agentId: 'agent', maxLines: 0 }), /maxLines/);
      await assert.rejects(client.request('execution.agent_log', { runId, agentId: 'agent', maxBytes: 65_537 }), /maxBytes/);
      await assert.rejects(client.request('execution.agent_log', { runId, agentId: 'agent', path: outsidePath }), /unknown field/);
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
      const archived = await client.request('project.archive', { projectId: project.id });
      assert.match(archived.archivedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(await client.request('project.list'), []);
      assert.deepEqual((await client.request('project.list', { includeArchived: true })).map((entry) => entry.id), [project.id]);

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
      await assert.rejects(client.request('project.list', { unexpected: true }), /unknown field/);
      await assert.rejects(client.request('project.list', { includeArchived: 'yes' }), /includeArchived/);
      await assert.rejects(client.request('project.archive', { projectId: '' }), /projectId/);
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

test('AgentTeamDaemon limits active runs globally and starts queued runs after a slot opens', async () => {
  await withHome(async (home) => {
    await mkdir(home.root, { recursive: true });
    await writeFile(join(home.root, 'config.yml'), `version: 1
concurrency:
  maxActiveRuns: 1
logs:
  retentionDays: 30
tui:
  color: auto
`, 'utf8');
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const releases = new Map([['queued-first', deferred()], ['queued-second', deferred()]]);
    const started = [];
    let active = 0;
    let peakActive = 0;
    const daemon = new AgentTeamDaemon(home, {
      runExecutor: async (input) => {
        started.push(input.runId);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await releases.get(input.runId).promise;
        active -= 1;
        input.db.updateRun(input.runId, { status: 'done' });
      }
    });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Globally limited execution', gitIdentity: {}, policy: projectPolicy()
      });
      assert.deepEqual(await client.request('execution.submit', {
        contract: executionContract(project, repoRoot), runId: 'queued-first'
      }), { runId: 'queued-first', scheduled: true });
      await waitFor(() => started.length === 1);
      assert.deepEqual(await client.request('execution.submit', {
        contract: executionContract(project, repoRoot), runId: 'queued-second'
      }), { runId: 'queued-second', scheduled: false });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(started, ['queued-first']);

      releases.get('queued-first').resolve();
      await waitFor(() => started.length === 2);
      assert.deepEqual(started, ['queued-first', 'queued-second']);
      assert.equal(peakActive, 1);
    } finally {
      releases.get('queued-first').resolve();
      releases.get('queued-second').resolve();
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
        throw new Error('executor cancelled');
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
      await waitFor(() => daemon.stateDatabase.getRun('active-cancellation').runtimeState === 'paused');
      const activeCancellation = daemon.stateDatabase.getRun('active-cancellation');
      assert.equal(activeCancellation.status, 'cancelled');
      assert.equal(activeCancellation.desiredState, 'cancel_requested');
      assert.equal(activeCancellation.runtimeState, 'paused');
      assert.equal(activeCancellation.error, 'Cancelled by controller; run again to resume.');
      assert.equal(eventTypes(daemon.stateDatabase, 'active-cancellation').filter((type) => type === 'RUN_CANCELLED').length, 1);
      assert.equal(eventTypes(daemon.stateDatabase, 'active-cancellation').includes('RUN_DAEMON_FAILED'), false);

      daemon.stateDatabase.createRun({
        id: 'planned-cancellation', repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'external'
      });
      daemon.stateDatabase.updateRun('planned-cancellation', { status: 'planned' });
      assert.deepEqual(await client.request('execution.cancel', { runId: 'planned-cancellation' }), {
        runId: 'planned-cancellation', cancelled: true
      });
      const plannedCancellation = daemon.stateDatabase.getRun('planned-cancellation');
      assert.equal(plannedCancellation.status, 'cancelled');
      assert.equal(plannedCancellation.desiredState, 'cancel_requested');
      assert.equal(plannedCancellation.error, 'Cancelled by controller; run again to resume.');
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
    await createExecutionRun({
      config: runnerConfigFromProjectPolicy(policy, project, home),
      db: database,
      contract: executionContract(project, repoRoot),
      projectPolicyRevisionId: policy.id,
      runId: 'paused-planned'
    });
    database.updateRun('paused-planned', { desiredState: 'paused', runtimeState: 'paused' });
    await createExecutionRun({
      config: runnerConfigFromProjectPolicy(policy, project, home),
      db: database,
      contract: executionContract(project, repoRoot),
      projectPolicyRevisionId: policy.id,
      runId: 'cancel-requested-running'
    });
    database.updateRun('cancel-requested-running', {
      status: 'running', desiredState: 'cancel_requested', runtimeState: 'cancelling'
    });
    database.close();
    registry.close();

    const executorInputs = [];
    const daemon = new AgentTeamDaemon(home, { runExecutor: async (input) => { executorInputs.push(input); } });
    try {
      await daemon.start();
      await waitFor(() => executorInputs.length === 2);
      assert.deepEqual(executorInputs.map((input) => input.runId).sort(), ['recover-planned', 'recover-running']);
      assert.equal(executorInputs[0].config.workspace.repoRoot, repoRoot);
      assert.equal(daemon.stateDatabase.getRun('paused-planned').runtimeState, 'paused');
      assert.equal(daemon.stateDatabase.getRun('cancel-requested-running').runtimeState, 'cancelling');
    } finally {
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon keeps paused runs unscheduled until execution.start restores desired running', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const paused = deferred();
    let firstExecutionStarted = false;
    const firstDaemon = new AgentTeamDaemon(home, {
      runExecutor: async (input) => {
        firstExecutionStarted = true;
        await new Promise((resolve) => input.signal.addEventListener('abort', resolve, { once: true }));
        paused.resolve();
      }
    });
    await firstDaemon.start();
    const firstClient = new LocalIpcClient(home.socket);
    try {
      await firstClient.connect();
      const project = await firstClient.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Pausable execution', gitIdentity: {}, policy: projectPolicy()
      });
      await firstClient.request('execution.submit', {
        contract: executionContract(project, repoRoot), runId: 'pause-recovery'
      });
      await waitFor(() => firstExecutionStarted);
      assert.deepEqual(await firstClient.request('execution.pause', { runId: 'pause-recovery' }), {
        runId: 'pause-recovery', paused: true
      });
      await paused.promise;
      await waitFor(() => firstDaemon.stateDatabase.getRun('pause-recovery').runtimeState === 'paused');
      assert.equal(firstDaemon.stateDatabase.getRun('pause-recovery').desiredState, 'paused');
    } finally {
      firstClient.close();
      await firstDaemon.stop();
    }

    const resumedExecutions = [];
    const secondDaemon = new AgentTeamDaemon(home, {
      runExecutor: async (input) => { resumedExecutions.push(input.runId); }
    });
    const secondClient = new LocalIpcClient(home.socket);
    try {
      await secondDaemon.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(resumedExecutions, []);
      assert.equal(secondDaemon.stateDatabase.getRun('pause-recovery').desiredState, 'paused');

      await secondClient.connect();
      assert.deepEqual(await secondClient.request('execution.start', { runId: 'pause-recovery' }), {
        runId: 'pause-recovery', scheduled: true
      });
      await waitFor(() => resumedExecutions.length === 1);
      assert.deepEqual(resumedExecutions, ['pause-recovery']);
      assert.equal(secondDaemon.stateDatabase.getRun('pause-recovery').desiredState, 'running');
    } finally {
      secondClient.close();
      await secondDaemon.stop();
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

test('AgentTeamDaemon persists contract blocks and non-activity agent events safely', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const store = new ControlPlaneStore(home.stateDb);
    const daemon = new AgentTeamDaemon(home, {
      controlPlaneStore: store,
      runExecutor: async (input) => {
        const task = input.db.getTask(input.runId, 'T001');
        const execution = {
          runId: input.runId, agentId: 'T001-worker-1', taskId: 'T001', role: 'worker', backend: 'codex',
          logPath: '/tmp/worker.log'
        };
        input.onAgentEvent(execution, { type: 'activity' });
        const circular = { command: 'npm test' };
        circular.self = circular;
        input.onAgentEvent(execution, { type: 'tool-call', tool: 'shell', input: circular });
        input.onAgentEvent(execution, {
          type: 'tool-call', tool: 'unserializable', input: { toJSON() { throw new Error('cannot serialize'); } }
        });
        input.onAgentEvent(execution, { type: 'tool-call', tool: 'values', input: [undefined, () => {}, Symbol('value'), 1n] });
        input.reportContractBlock({
          task,
          agentExecution: { ...execution, sessionId: 'worker-session' },
          reason: {
            code: 'out_of_scope', message: 'Task must own src/other.ts.',
            requestedContractChanges: ['Add src/other.ts to allowedPaths'], affectedPaths: ['src/other.ts']
          }
        });
      }
    });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Contract block execution', gitIdentity: {}, policy: projectPolicy()
      });
      await client.request('execution.submit', { contract: executionContract(project, repoRoot), runId: 'contract-block-execution' });
      await waitFor(() => store.listInteractions('contract-block-execution').length === 1);

      assert.deepEqual(store.listInteractions('contract-block-execution')[0], {
        ...store.listInteractions('contract-block-execution')[0],
        runId: 'contract-block-execution',
        taskId: 'T001',
        agentId: 'T001-worker-1',
        sessionId: 'worker-session',
        kind: 'contract_block',
        request: {
          type: 'blocked_on_contract',
          taskId: 'T001',
          task: { title: 'Create feature', externalId: 'SPEC-1' },
          attempt: 0,
          reason: {
            code: 'out_of_scope', message: 'Task must own src/other.ts.',
            requestedContractChanges: ['Add src/other.ts to allowedPaths'], affectedPaths: ['src/other.ts']
          }
        },
        status: 'queued',
        claimedByClientId: null,
        response: null,
        claimedAt: null,
        answeredAt: null,
        cancelledAt: null,
        expiredAt: null,
        expiresAt: null,
        idempotencyKey: null
      });
      const events = daemon.stateDatabase.listEvents('contract-block-execution');
      assert.equal(events.filter((event) => event.eventType === 'AGENT_EVENT').length, 3);
      assert.deepEqual(events.find((event) => event.eventType === 'AGENT_EVENT')?.payload, {
        execution: {
          runId: 'contract-block-execution', agentId: 'T001-worker-1', taskId: 'T001', role: 'worker', backend: 'codex',
          logPath: '/tmp/worker.log'
        },
        event: { type: 'tool-call', tool: 'shell', input: { command: 'npm test', self: null } }
      });
      const agentEvents = events.filter((event) => event.eventType === 'AGENT_EVENT');
      assert.equal(agentEvents.at(-2)?.payload, null);
      assert.deepEqual(agentEvents.at(-1)?.payload, {
        execution: {
          runId: 'contract-block-execution', agentId: 'T001-worker-1', taskId: 'T001', role: 'worker', backend: 'codex',
          logPath: '/tmp/worker.log'
        },
        event: { type: 'tool-call', tool: 'values', input: [null, null, null, '1'] }
      });
    } finally {
      client.close();
      await daemon.stop();
      store.close();
    }
  });
});

test('AgentTeamDaemon ignores contract-block persistence failures', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const store = new ControlPlaneStore(home.stateDb);
    store.queueInteraction = () => { throw new Error('store unavailable'); };
    let executorCompleted = false;
    const daemon = new AgentTeamDaemon(home, {
      controlPlaneStore: store,
      runExecutor: async (input) => {
        const addEvent = input.db.addEvent.bind(input.db);
        input.db.addEvent = () => { throw new Error('events unavailable'); };
        input.onAgentEvent({ runId: input.runId, agentId: 'T001-worker-1', role: 'worker', backend: 'codex', logPath: '/tmp/worker.log' }, {
          type: 'message', text: 'continue'
        });
        input.db.addEvent = addEvent;
        const task = input.db.getTask(input.runId, 'T001');
        task.specJson = '{}';
        input.reportContractBlock({
          task,
          agentExecution: { agentId: 'T001-worker-1', sessionId: null },
          reason: { code: 'other', message: 'Contract decision needed.', requestedContractChanges: [] }
        });
        executorCompleted = true;
      }
    });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Unavailable contract store', gitIdentity: {}, policy: projectPolicy()
      });
      await client.request('execution.submit', { contract: executionContract(project, repoRoot), runId: 'contract-block-store-failure' });
      await waitFor(() => executorCompleted);
      assert.equal(daemon.stateDatabase.getRun('contract-block-store-failure').status, 'planned');
      assert.equal(eventTypes(daemon.stateDatabase, 'contract-block-store-failure').includes('RUN_DAEMON_FAILED'), false);
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

test('AgentTeamDaemon revises a blocked execution contract and resets its downstream tasks', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    await mkdir(join(repoRoot, '.agents', 'skills', 'test-skill'), { recursive: true });
    await writeFile(join(repoRoot, '.agents', 'skills', 'test-skill', 'SKILL.md'), 'first snapshot', 'utf8');
    let executions = 0;
    const daemon = new AgentTeamDaemon(home, {
      runExecutor: async (input) => {
        executions += 1;
        if (executions !== 1) return;
        input.reportContractBlock({
          task: input.db.getTask(input.runId, 'T001'),
          agentExecution: { agentId: 'T001-worker-1', sessionId: 'worker-session' },
          reason: { code: 'out_of_scope', message: 'Need another source path.', requestedContractChanges: ['Allow src/other.ts'] }
        });
        input.db.updateTask(input.runId, 'T001', { status: 'blocked_on_contract' });
      }
    });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Revision execution', gitIdentity: {}, policy: projectPolicy()
      });
      const contract = executionContract(project, repoRoot);
      await client.request('execution.submit', { contract, runId: 'revision-execution' });
      await waitFor(() => daemon.stateDatabase.getTask('revision-execution', 'T001').status === 'blocked_on_contract');
      assert.equal(JSON.parse(daemon.stateDatabase.getTask('revision-execution', 'T001').resolvedSkillsJson)[0].content, 'first snapshot');
      await writeFile(join(repoRoot, '.agents', 'skills', 'test-skill', 'SKILL.md'), 'revised snapshot', 'utf8');
      const revised = {
        ...contract,
        tasks: [
          { ...contract.tasks[0], allowedPaths: ['src/**', 'lib/**'] },
          {
            ...contract.tasks[0], id: 'T002', externalId: 'SPEC-2', title: 'Verify changed contract',
            description: 'Implement the dependent work.', dependsOn: ['T001']
          }
        ]
      };
      const updated = await client.request('execution.update_contract', { runId: 'revision-execution', contract: revised });
      assert.deepEqual(updated, {
        runId: 'revision-execution', revision: 2, affectedTaskIds: ['T001', 'T002'], scheduled: true
      });
      await waitFor(() => executions === 2);
      assert.equal(daemon.stateDatabase.getRun('revision-execution').contractRevision, 2);
      assert.deepEqual(daemon.stateDatabase.listContractRevisions('revision-execution').map((entry) => entry.revision), [1, 2]);
      assert.deepEqual(daemon.stateDatabase.listTasks('revision-execution').map((task) => [task.taskId, task.status]), [
        ['T001', 'pending'], ['T002', 'pending']
      ]);
      for (const taskId of ['T001', 'T002']) {
        const [skill] = JSON.parse(daemon.stateDatabase.getTask('revision-execution', taskId).resolvedSkillsJson);
        assert.equal(skill.content, 'revised snapshot');
      }
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon validates and lists external execution contracts through IPC', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const daemon = new AgentTeamDaemon(home, { runExecutor: async () => {} });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Validated execution', gitIdentity: {}, policy: projectPolicy()
      });
      const contract = executionContract(project, repoRoot);
      assert.deepEqual(await client.request('execution.validate', { contract }), {
        valid: true, taskCount: 1, projectPolicyRevisionId: project.currentPolicyRevisionId
      });
      await assert.rejects(client.request('execution.validate', {
        contract: { ...contract, tasks: [{ ...contract.tasks[0], verificationCommands: ['git status'] }] }
      }), /allowlisted/);
      await assert.rejects(client.request('execution.validate', {}), /contract is required/);

      await client.request('execution.submit', { contract, runId: 'listed-execution-a' });
      await client.request('execution.submit', { contract, runId: 'listed-execution-b' });
      assert.deepEqual((await client.request('execution.list')).map((run) => run.id).sort(), [
        'listed-execution-a', 'listed-execution-b'
      ]);
      assert.deepEqual((await client.request('execution.list', { projectId: project.id })).map((run) => run.id).sort(), [
        'listed-execution-a', 'listed-execution-b'
      ]);
      assert.deepEqual(await client.request('execution.list', { projectId: 'missing-project' }), []);
      await assert.rejects(client.request('execution.list', { projectId: 1 }), /projectId/);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon enforces blocked contract revision boundaries', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const daemon = new AgentTeamDaemon(home, { runExecutor: async () => {} });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Revision boundaries', gitIdentity: {}, policy: projectPolicy()
      });
      const first = executionContract(project, repoRoot).tasks[0];
      const contract = {
        ...executionContract(project, repoRoot),
        tasks: [
          first,
          { ...first, id: 'T002', externalId: 'SPEC-2', title: 'Independent task', allowedPaths: ['lib/**'], dependsOn: [] }
        ]
      };
      await client.request('execution.submit', { contract, runId: 'revision-boundaries' });

      await assert.rejects(client.request('execution.update_contract', {
        runId: 'revision-boundaries', contract
      }), /no blocked_on_contract task/);
      daemon.stateDatabase.updateTask('revision-boundaries', 'T001', { status: 'blocked_on_contract' });

      await assert.rejects(client.request('execution.update_contract', {
        runId: 'revision-boundaries', contract: { ...contract, project: { ...contract.project, baseRef: 'other' } }
      }), /cannot change the run project or base ref/);
      await assert.rejects(client.request('execution.update_contract', {
        runId: 'revision-boundaries', contract: {
          ...contract,
          tasks: [...contract.tasks, {
            ...first, id: 'T003', externalId: 'SPEC-3', title: 'Unrelated task', allowedPaths: ['test/**'], dependsOn: []
          }]
        }
      }), /must depend on a contract-blocked task/);
      daemon.stateDatabase.updateTask('revision-boundaries', 'T001', { status: 'blocked_on_contract' });
      await assert.rejects(client.request('execution.update_contract', {
        runId: 'revision-boundaries', contract: {
          ...contract, tasks: [first, { ...contract.tasks[1], allowedPaths: ['test/**'] }]
        }
      }), /can only change blocked tasks or their downstream tasks/);

      daemon.stateDatabase.updateTask('revision-boundaries', 'T001', { status: 'blocked_on_contract' });
      daemon.stateDatabase.updateTask('revision-boundaries', 'T002', { status: 'approved' });
      await assert.rejects(client.request('execution.update_contract', {
        runId: 'revision-boundaries', contract: {
          ...contract, tasks: [first, { ...contract.tasks[1], allowedPaths: ['test/**'] }]
        }
      }), /cannot change approved task T002/);
    } finally {
      client.close();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon returns completed handoffs and reports unavailable or invalid files', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const daemon = new AgentTeamDaemon(home, {
      runExecutor: async (input) => { input.db.updateRun(input.runId, { status: 'done' }); }
    });
    await daemon.start();
    const client = new LocalIpcClient(home.socket);
    try {
      await client.connect();
      const project = await client.request('project.register', {
        gitCommonDir, repoRoot, displayName: 'Handoff execution', gitIdentity: {}, policy: projectPolicy()
      });
      const submitted = await client.request('execution.submit', {
        contract: executionContract(project, repoRoot), runId: 'handoff-execution'
      });
      await waitFor(() => eventTypes(daemon.stateDatabase, submitted.runId).includes('RUN_HANDOFF_CREATED'));
      const handoff = await client.request('execution.handoff', { runId: submitted.runId });
      assert.equal(handoff.run.id, submitted.runId);
      assert.equal(handoff.run.status, 'done');
      assert.deepEqual(handoff.tasks.map((task) => task.id), ['T001']);
      assert.equal(handoff.contract.project.id, project.id);

      await assert.rejects(client.request('execution.handoff', { runId: 'missing-handoff' }), /has no handoff/);
      await writeFile(join(home.runsDir, submitted.runId, 'handoff.json'), '{', 'utf8');
      await assert.rejects(client.request('execution.handoff', { runId: submitted.runId }));
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

test('AgentTeamDaemon rejects invalid contract revision states before scheduling', async () => {
  await withHome(async (home) => {
    const { repoRoot, gitCommonDir } = await repository(dirname(home.root));
    const handlers = new Map();
    const server = {
      register(method, handler) { handlers.set(method, handler); },
      async start() {},
      async stop() {}
    };
    const daemon = new AgentTeamDaemon(home, { server, runExecutor: async () => {} });
    const update = handlers.get('execution.update_contract');
    const project = daemon.projectRegistry.registerProject({
      gitCommonDir, repoRoot, displayName: 'Revision cases', gitIdentity: {}, policy: projectPolicy()
    });
    const contract = executionContract(project, repoRoot);
    try {
      await assert.rejects(update({ runId: 'missing-contract' }), /contract is required/);

      daemon.activeRuns.set('active-run', {});
      await assert.rejects(update({ runId: 'active-run', contract }), /is active/);
      daemon.activeRuns.clear();

      daemon.stateDatabase.createRun({
        id: 'legacy-run', repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'external'
      });
      await assert.rejects(update({ runId: 'legacy-run', contract }), /no external execution contract/);

      daemon.stateDatabase.createRun({
        id: 'policy-fallback', repoRoot, goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base',
        projectId: project.id, executionContractJson: JSON.stringify(contract), adapter: 'external'
      });
      await assert.rejects(update({ runId: 'policy-fallback', contract }), /no blocked_on_contract task/);

      const policy = daemon.projectRegistry.getProjectPolicy(project.id);
      await createExecutionRun({
        config: runnerConfigFromProjectPolicy(policy, project, home), db: daemon.stateDatabase, contract,
        projectPolicyRevisionId: policy.id, runId: 'removed-task'
      });
      await assert.rejects(update({
        runId: 'removed-task',
        contract: { ...contract, tasks: [{ ...contract.tasks[0], id: 'T002', externalId: 'SPEC-2', title: 'Replacement task' }] }
      }), /cannot remove task T001/);
    } finally {
      daemon.activeRuns.clear();
      await daemon.stop();
    }
  });
});

test('AgentTeamDaemon handoff includes populated optional task fields and null contracts', async () => {
  await withHome(async (home) => {
    const daemon = new AgentTeamDaemon(home);
    const runId = 'legacy-handoff';
    daemon.stateDatabase.createRun({
      id: runId, repoRoot: '/repos/handoff', goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'cli'
    });
    daemon.stateDatabase.insertTask(runId, executionContract({ id: 'project' }, '/repos/handoff').tasks[0]);
    daemon.stateDatabase.updateTask(runId, 'T001', { commitSha: 'deadbeef', reviewJson: JSON.stringify({ decision: 'approved' }) });
    daemon.stateDatabase.updateRun(runId, { status: 'done' });
    await mkdir(join(home.runsDir, runId), { recursive: true });
    try {
      daemon.writeHandoff(runId);
      const handoff = JSON.parse(await (await import('node:fs/promises')).readFile(join(home.runsDir, runId, 'handoff.json'), 'utf8'));
      assert.equal(handoff.contract, null);
      assert.deepEqual(handoff.tasks[0].review, { decision: 'approved' });
      assert.match(await (await import('node:fs/promises')).readFile(join(home.runsDir, runId, 'handoff.md'), 'utf8'), /deadbeef/);
    } finally {
      await daemon.stop();
    }
  });
});
