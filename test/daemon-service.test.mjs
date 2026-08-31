import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentTeamHome } from '../src/core/home.ts';
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
