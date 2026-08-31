import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlPlaneStore } from '../src/daemon/control-plane-store.ts';

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-control-plane-store-'));
  const path = join(directory, 'nested', 'state.sqlite');
  const store = new ControlPlaneStore(path);
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function interactionInput(overrides = {}) {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    kind: 'approval',
    request: { command: 'npm test', risks: ['network'] },
    ...overrides
  };
}

test('queues persistent JSON interactions, filters them, and lists oldest first', () => {
  withStore((store, path) => {
    const later = store.queueInteraction(interactionInput({ request: { sequence: 2 } }));
    const earlier = store.queueInteraction(interactionInput({
      runId: 'run-2',
      taskId: null,
      sessionId: null,
      kind: 'contract_block',
      request: { sequence: 1 }
    }));
    store.db.prepare('UPDATE interactions SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', earlier.id);

    assert.equal(existsSync(path), true);
    assert.match(later.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(store.listInteractions().map((interaction) => interaction.id), [earlier.id, later.id]);
    assert.deepEqual(store.listInteractions('run-1'), [later]);
    assert.deepEqual(store.listInteractions('missing'), []);
    assert.deepEqual(earlier, {
      ...earlier,
      taskId: null,
      sessionId: null,
      request: { sequence: 1 },
      status: 'queued',
      claimedByClientId: null,
      response: null,
      claimedAt: null,
      resolvedAt: null
    });
    assert.deepEqual(
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
      ['external_run_controllers', 'interactions']
    );
    assert.deepEqual(
      store.db.prepare("SELECT name, strict FROM pragma_table_list WHERE name IN ('interactions', 'external_run_controllers') ORDER BY name").all().map((row) => ({ ...row })),
      [{ name: 'external_run_controllers', strict: 1 }, { name: 'interactions', strict: 1 }]
    );
  });
});

test('claims, answers, and requeues interactions with ownership and idempotency checks', () => {
  withStore((store) => {
    const interaction = store.queueInteraction(interactionInput());
    const claimed = store.claimInteraction(interaction.id, 'client-a');
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.claimedByClientId, 'client-a');
    assert.ok(claimed.claimedAt);
    assert.throws(() => store.claimInteraction(interaction.id, 'client-b'), /not queued/);
    assert.throws(() => store.claimInteraction('missing', 'client-a'), /not queued/);
    assert.throws(() => store.answerInteraction(interaction.id, 'client-b', { approved: true }), /cannot be answered/);

    const answered = store.answerInteraction(interaction.id, 'client-a', { approved: true, notes: ['safe'] });
    assert.equal(answered.status, 'resolved');
    assert.deepEqual(answered.response, { approved: true, notes: ['safe'] });
    assert.ok(answered.resolvedAt);
    assert.deepEqual(store.answerInteraction(interaction.id, 'client-a', { approved: true, notes: ['safe'] }), answered);
    assert.throws(() => store.answerInteraction(interaction.id, 'client-b', { approved: true, notes: ['safe'] }), /cannot be answered/);
    assert.throws(() => store.answerInteraction(interaction.id, 'client-a', { approved: false }), /cannot be answered/);
    assert.throws(() => store.answerInteraction('missing', 'client-a', { approved: true }), /not found/);

    const requeued = store.queueInteraction(interactionInput({ taskId: null, sessionId: null }));
    store.claimInteraction(requeued.id, 'client-a');
    const retained = store.queueInteraction(interactionInput({ runId: 'run-2' }));
    store.claimInteraction(retained.id, 'client-b');
    assert.equal(store.requeueClientInteractions('client-a'), 1);
    assert.equal(store.requeueClientInteractions('client-a'), 0);
    assert.deepEqual(store.listInteractions('run-1').find((entry) => entry.id === requeued.id), {
      ...requeued,
      status: 'queued',
      claimedByClientId: null,
      claimedAt: null
    });
    assert.equal(store.claimInteraction(requeued.id, 'client-b').claimedByClientId, 'client-b');
    assert.equal(store.listInteractions('run-2').find((entry) => entry.id === retained.id)?.claimedByClientId, 'client-b');
  });
});

test('gets interactions and waits for persistent answers without changing their state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-control-plane-store-'));
  const path = join(directory, 'nested', 'state.sqlite');
  const store = new ControlPlaneStore(path);
  try {
    const resolved = store.queueInteraction(interactionInput({ request: { immediate: true } }));
    store.claimInteraction(resolved.id, 'client-a');
    store.answerInteraction(resolved.id, 'client-a', { approved: true });
    assert.deepEqual(store.getInteraction(resolved.id).response, { approved: true });
    assert.deepEqual(await store.waitForInteractionAnswer(resolved.id, {
      sleep: () => assert.fail('resolved interactions must not sleep')
    }), { approved: true });

    const queued = store.queueInteraction(interactionInput({ request: { delayed: true } }));
    const sleepCalls = [];
    assert.deepEqual(await store.waitForInteractionAnswer(queued.id, {
      pollIntervalMs: 7,
      sleep: async (milliseconds) => {
        sleepCalls.push(milliseconds);
        store.claimInteraction(queued.id, 'client-a');
        store.answerInteraction(queued.id, 'client-a', ['approved']);
      }
    }), ['approved']);
    assert.deepEqual(sleepCalls, [7]);
    assert.equal(store.getInteraction(queued.id).status, 'resolved');
    assert.throws(() => store.getInteraction('missing'), /not found/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects invalid interaction waits and honors abort signals', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-control-plane-store-'));
  const store = new ControlPlaneStore(join(directory, 'nested', 'state.sqlite'));
  try {
    const interaction = store.queueInteraction(interactionInput());
    await assert.rejects(
      store.waitForInteractionAnswer(interaction.id, { pollIntervalMs: 0 }),
      /positive integer/
    );
    await assert.rejects(
      store.waitForInteractionAnswer(interaction.id, { pollIntervalMs: 1.5 }),
      /positive integer/
    );

    const controller = new AbortController();
    const reason = new Error('stop waiting');
    controller.abort(reason);
    await assert.rejects(
      store.waitForInteractionAnswer('missing', { signal: controller.signal }),
      (error) => error === reason
    );

    await assert.rejects(store.waitForInteractionAnswer('missing'), /not found/);

    await assert.rejects(
      store.waitForInteractionAnswer('missing', {
        signal: {
          aborted: true,
          reason: undefined,
          addEventListener() {},
          removeEventListener() {}
        }
      }),
      /Waiting for interaction answer was aborted/
    );

    const answeredWhileWaiting = store.queueInteraction(interactionInput());
    const activeController = new AbortController();
    assert.deepEqual(await store.waitForInteractionAnswer(answeredWhileWaiting.id, {
      signal: activeController.signal,
      sleep: async () => {
        store.claimInteraction(answeredWhileWaiting.id, 'client-a');
        store.answerInteraction(answeredWhileWaiting.id, 'client-a', 'answered');
      }
    }), 'answered');

    const sleepError = new Error('sleep failed');
    const rejectedSleep = store.queueInteraction(interactionInput());
    await assert.rejects(
      store.waitForInteractionAnswer(rejectedSleep.id, {
        signal: new AbortController().signal,
        sleep: () => Promise.reject(sleepError)
      }),
      (error) => error === sleepError
    );

    const abortedWhileWaiting = store.queueInteraction(interactionInput());
    const abortWhileSleeping = new AbortController();
    const pendingAnswer = store.waitForInteractionAnswer(abortedWhileWaiting.id, {
      signal: abortWhileSleeping.signal,
      sleep: () => new Promise(() => {})
    });
    abortWhileSleeping.abort();
    await assert.rejects(pendingAnswer, /aborted/);

    const defaultSleep = store.queueInteraction(interactionInput());
    const defaultWait = store.waitForInteractionAnswer(defaultSleep.id);
    setTimeout(() => {
      store.claimInteraction(defaultSleep.id, 'client-a');
      store.answerInteraction(defaultSleep.id, 'client-a', null);
    }, 0);
    assert.equal(await defaultWait, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('attaches controllers, preserves same-client ownership, and reconnects disconnected runs', () => {
  withStore((store) => {
    const initial = store.attachController({
      runId: 'run-b', host: 'host-a', externalThreadId: 'thread-a', clientId: 'client-a'
    });
    assert.deepEqual(initial, {
      runId: 'run-b',
      host: 'host-a',
      externalThreadId: 'thread-a',
      clientId: 'client-a',
      status: 'connected',
      lastAckEventId: null,
      claimedAt: initial.claimedAt,
      releasedAt: null
    });

    const updated = store.attachController({
      runId: 'run-b', host: 'host-new', externalThreadId: 'thread-new', clientId: 'client-a', lastAckEventId: 42
    });
    assert.equal(updated.host, 'host-a');
    assert.equal(updated.externalThreadId, 'thread-a');
    assert.equal(updated.lastAckEventId, 42);
    assert.throws(
      () => store.attachController({ runId: 'run-b', host: 'host-b', externalThreadId: 'thread-b', clientId: 'client-b' }),
      /owned by another/
    );
    assert.throws(() => store.disconnectController('run-b', 'client-b'), /not owned/);

    const disconnected = store.disconnectController('run-b', 'client-a');
    assert.equal(disconnected.status, 'disconnected');
    assert.ok(disconnected.releasedAt);
    assert.deepEqual(store.disconnectController('run-b', 'client-a'), disconnected);
    assert.deepEqual(store.listReconnectableRuns(), [disconnected]);
    assert.throws(() => store.disconnectController('missing', 'client-a'), /not found/);

    const reclaimed = store.attachController({
      runId: 'run-b', host: 'host-b', externalThreadId: 'thread-b', clientId: 'client-b', lastAckEventId: 43
    });
    assert.deepEqual(reclaimed, {
      ...reclaimed,
      host: 'host-b',
      externalThreadId: 'thread-b',
      clientId: 'client-b',
      status: 'connected',
      lastAckEventId: 43,
      releasedAt: null
    });
    assert.deepEqual(store.listReconnectableRuns(), []);
  });
});

test('acknowledges controller cursors only for the connected owner', () => {
  withStore((store) => {
    store.attachController({ runId: 'run-ack', host: 'host', externalThreadId: 'thread', clientId: 'client-a' });
    assert.equal(store.acknowledgeController('run-ack', 'client-a', 9).lastAckEventId, 9);
    assert.equal(store.getController('run-ack').lastAckEventId, 9);
    assert.throws(() => store.acknowledgeController('run-ack', 'client-b', 10), /not owned/);
    assert.throws(() => store.acknowledgeController('missing', 'client-a', 10), /not found/);
    assert.throws(() => store.acknowledgeController('run-ack', 'client-a', -1), /non-negative integer/);
    assert.throws(() => store.acknowledgeController('run-ack', 'client-a', 1.5), /non-negative integer/);

    store.disconnectController('run-ack', 'client-a');
    assert.throws(() => store.acknowledgeController('run-ack', 'client-a', 10), /not owned/);
    const reconnected = store.attachController({
      runId: 'run-ack', host: 'host', externalThreadId: 'thread', clientId: 'client-a'
    });
    assert.equal(reconnected.lastAckEventId, 9);
  });
});
