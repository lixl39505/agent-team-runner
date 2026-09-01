import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createHostCapabilityRegistry,
  hostCapabilityNames,
  hostNames,
  probeHostCapabilities
} from '../src/host/capabilities.ts';
import { HostAdapter } from '../src/host/adapter.ts';

const request = {
  host: 'codex', externalThreadId: 'thread-1', runId: 'run-1', clientId: 'client-1', explicitlyRequested: true
};

test('Host capability registry keeps every built-in Host capability unverified and disabled by default', () => {
  const registry = createHostCapabilityRegistry();
  assert.deepEqual(Object.keys(registry), [...hostNames]);
  for (const host of hostNames) {
    assert.deepEqual(Object.keys(registry[host].capabilities), [...hostCapabilityNames]);
    for (const capability of hostCapabilityNames) {
      assert.deepEqual(registry[host].capabilities[capability], { declared: false, probe: 'unverified' });
    }
  }
});

test('Host capability probes record observations without enabling an outer Host capability', async () => {
  const profile = await probeHostCapabilities(createHostCapabilityRegistry(), 'opencode', {
    async probe(_host, capability) {
      if (capability === 'idleEvent') throw new Error('unavailable');
      return capability === 'logging';
    }
  });
  assert.deepEqual(profile.capabilities.logging, { declared: false, probe: 'supported' });
  assert.deepEqual(profile.capabilities.idleEvent, { declared: false, probe: 'unsupported' });
  assert.deepEqual(profile.capabilities.elicitation, { declared: false, probe: 'unsupported' });
});

test('Host adapter is fail-closed until the caller explicitly requests a declared action', async () => {
  let calls = 0;
  const adapter = new HostAdapter({
    declarations: { codex: { resumeExternalThread: true, startReviewTurn: true } },
    transports: {
      codex: {
        async resumeExternalThread() { calls += 1; },
        async startReviewTurn() { throw new Error('Host transport disconnected'); }
      }
    }
  });

  assert.deepEqual(await adapter.resumeExternalThread({ ...request, explicitlyRequested: false }), {
    action: 'resumeExternalThread', host: 'codex', externalThreadId: 'thread-1', attempted: false,
    status: 'not_requested', fallback: 'durable_context_and_tui'
  });
  assert.equal(calls, 0);
  assert.deepEqual(await new HostAdapter().resumeExternalThread(request), {
    action: 'resumeExternalThread', host: 'codex', externalThreadId: 'thread-1', attempted: false,
    status: 'undeclared', fallback: 'durable_context_and_tui'
  });
  assert.equal((await adapter.resumeExternalThread(request)).status, 'completed');
  assert.equal(calls, 1);
  assert.deepEqual(await adapter.startReviewTurn(request), {
    action: 'startReviewTurn', host: 'codex', externalThreadId: 'thread-1', attempted: true,
    status: 'failed', fallback: 'durable_context_and_tui', error: 'Host transport disconnected'
  });
});

test('Host adapter refuses unknown Hosts and declared actions without a transport', async () => {
  const adapter = new HostAdapter({ declarations: { 'claude-code': { startReviewTurn: true } } });
  assert.equal((await adapter.startReviewTurn({ ...request, host: 'unknown-host' })).status, 'undeclared');
  assert.equal((await adapter.startReviewTurn({ ...request, host: 'claude-code' })).status, 'unavailable');
});

test('Host adapter serializes non-Error transport failures', async () => {
  const adapter = new HostAdapter({
    declarations: { codex: { resumeExternalThread: true } },
    transports: { codex: { async resumeExternalThread() { throw 'transport unavailable'; } } }
  });
  assert.deepEqual(await adapter.resumeExternalThread(request), {
    action: 'resumeExternalThread', host: 'codex', externalThreadId: 'thread-1', attempted: true,
    status: 'failed', fallback: 'durable_context_and_tui', error: 'transport unavailable'
  });
});
