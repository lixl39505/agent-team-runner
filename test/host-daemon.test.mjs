import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { resolveAgentTeamHome } from '../src/core/home.ts';
import { LocalIpcClient } from '../src/daemon/ipc.ts';
import { AgentTeamDaemon } from '../src/daemon/service.ts';
import { HostAdapter } from '../src/host/adapter.ts';

test('daemon reads the durable controller Host/thread and preserves it when adapter actions fail closed', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-team-host-daemon-'));
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  const resumed = [];
  const daemon = new AgentTeamDaemon(home, {
    hostAdapter: new HostAdapter({
      declarations: { codex: { resumeExternalThread: true } },
      transports: { codex: { async resumeExternalThread(request) { resumed.push(request); } } }
    })
  });
  daemon.stateDatabase.createRun({
    id: 'run-1', repoRoot: '/repo', goalFile: 'goal.md', baseRef: 'HEAD', baseSha: 'base', adapter: 'external'
  });
  const client = new LocalIpcClient(home.socket);
  try {
    await daemon.start();
    await client.connect();
    await client.request('controller.attach', {
      runId: 'run-1', host: 'codex', externalThreadId: 'thread-1', clientId: 'client-1'
    });
    const capability = await client.request('host.capabilities', { host: 'codex' });
    assert.deepEqual(capability.capabilities.resumeExternalThread, { declared: true, probe: 'unverified' });
    assert.deepEqual(await client.request('host.capabilities', { host: 'not-a-host' }), {
      host: 'not-a-host', known: false, capabilities: null
    });

    assert.equal((await client.request('controller.resume_external_thread', {
      runId: 'run-1', clientId: 'client-1', explicitlyRequested: false
    })).status, 'not_requested');
    assert.equal(resumed.length, 0);
    assert.equal((await client.request('controller.resume_external_thread', {
      runId: 'run-1', clientId: 'client-1', explicitlyRequested: true
    })).status, 'completed');
    assert.deepEqual(resumed, [{
      host: 'codex', externalThreadId: 'thread-1', runId: 'run-1', clientId: 'client-1', explicitlyRequested: true
    }]);
    assert.equal((await client.request('controller.start_review_turn', {
      runId: 'run-1', clientId: 'client-1', explicitlyRequested: true
    })).status, 'undeclared');
    assert.deepEqual(daemon.controlPlaneStore.getController('run-1'), {
      runId: 'run-1', host: 'codex', externalThreadId: 'thread-1', clientId: 'client-1',
      status: 'connected', lastAckEventId: null,
      claimedAt: daemon.controlPlaneStore.getController('run-1').claimedAt, releasedAt: null
    });
    await assert.rejects(client.request('controller.resume_external_thread', {
      runId: 'run-1', clientId: 'other-client', explicitlyRequested: true
    }), /not owned/);
    await assert.rejects(client.request('controller.start_review_turn', {
      runId: 'run-1', clientId: 'client-1', explicitlyRequested: 'yes'
    }), /explicitlyRequested/);
  } finally {
    client.close();
    await daemon.stop();
    await rm(parent, { recursive: true, force: true });
  }
});
