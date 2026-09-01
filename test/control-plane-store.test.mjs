import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
      answeredAt: null,
      cancelledAt: null,
      expiredAt: null,
      expiresAt: null,
      idempotencyKey: null
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
    assert.equal(answered.status, 'answered');
    assert.deepEqual(answered.response, { approved: true, notes: ['safe'] });
    assert.ok(answered.answeredAt);
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
      sleep: () => assert.fail('answered interactions must not sleep')
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
    assert.equal(store.getInteraction(queued.id).status, 'answered');
    assert.throws(() => store.getInteraction('missing'), /not found/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates resolved interactions to answered without losing their response', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-control-plane-store-'));
  const path = join(directory, 'state.sqlite');
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE interactions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT, agent_id TEXT NOT NULL, session_id TEXT,
        kind TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL, claimed_by_client_id TEXT,
        response_json TEXT, created_at TEXT NOT NULL, claimed_at TEXT, resolved_at TEXT
      ) STRICT;
    `);
    database.prepare(`
      INSERT INTO interactions VALUES (?, ?, NULL, ?, NULL, ?, ?, 'resolved', ?, ?, ?, ?, ?)
    `).run(
      'legacy', 'run-1', 'agent-1', 'approval', JSON.stringify({ command: 'npm test' }), 'client-a',
      JSON.stringify({ approved: true }), '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z'
    );
  } finally {
    database.close();
  }

  const store = new ControlPlaneStore(path);
  try {
    assert.deepEqual(store.getInteraction('legacy'), {
      id: 'legacy', runId: 'run-1', taskId: null, agentId: 'agent-1', sessionId: null, kind: 'approval',
      request: { command: 'npm test' }, status: 'answered', claimedByClientId: 'client-a',
      response: { approved: true }, createdAt: '2026-01-01T00:00:00.000Z',
      claimedAt: '2026-01-01T00:01:00.000Z', answeredAt: '2026-01-01T00:02:00.000Z',
      cancelledAt: null, expiredAt: null, expiresAt: null, idempotencyKey: null
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps answers idempotent and preserves cancelled and expired terminal interactions', () => {
  withStore((store) => {
    const answered = store.queueInteraction(interactionInput());
    store.claimInteraction(answered.id, 'client-a');
    const firstAnswer = store.answerInteraction(answered.id, 'client-a', { approved: true }, 'answer-1');
    assert.equal(firstAnswer.idempotencyKey, 'answer-1');
    assert.deepEqual(
      store.answerInteraction(answered.id, 'client-a', { approved: false }, 'answer-1'),
      firstAnswer
    );
    assert.throws(
      () => store.answerInteraction(answered.id, 'client-a', { approved: true }, 'answer-2'),
      /cannot be answered/
    );

    const cancelled = store.cancelInteraction(store.queueInteraction(interactionInput()).id);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.cancelledAt);
    assert.deepEqual(store.cancelInteraction(cancelled.id), cancelled);

    const explicitlyExpired = store.expireInteraction(store.queueInteraction(interactionInput()).id);
    assert.equal(explicitlyExpired.status, 'expired');
    assert.ok(explicitlyExpired.expiredAt);
    assert.deepEqual(store.expireInteraction(explicitlyExpired.id), explicitlyExpired);

    const due = store.queueInteraction(interactionInput({ expiresAt: '2000-01-01T00:00:00.000Z' }));
    assert.equal(due.status, 'expired');
    assert.equal(due.expiresAt, '2000-01-01T00:00:00.000Z');
    assert.throws(() => store.claimInteraction(due.id, 'client-a'), /not queued/);
    assert.throws(() => store.queueInteraction(interactionInput({ expiresAt: 'not-a-date' })), /valid timestamp/);

    assert.equal(store.requeueClientInteractions('client-a'), 0);
    assert.equal(store.getInteraction(answered.id).status, 'answered');
    assert.equal(store.getInteraction(cancelled.id).status, 'cancelled');
    assert.equal(store.getInteraction(explicitlyExpired.id).status, 'expired');
  });
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

    const cancelled = store.queueInteraction(interactionInput());
    store.cancelInteraction(cancelled.id);
    await assert.rejects(store.waitForInteractionAnswer(cancelled.id), /cancelled/);
    const expired = store.queueInteraction(interactionInput({ expiresAt: '2000-01-01T00:00:00.000Z' }));
    await assert.rejects(store.waitForInteractionAnswer(expired.id), /expired/);
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

test('reclaims expired controller leases and rejects expired ownership operations', () => {
  withStore((store) => {
    store.attachController({ runId: 'run-lease', host: 'host-a', externalThreadId: 'thread-a', clientId: 'client-a' });
    store.db.prepare('UPDATE external_run_controllers SET lease_expires_at = ? WHERE run_id = ?')
      .run('2000-01-01T00:00:00.000Z', 'run-lease');

    assert.throws(() => store.heartbeatController('run-lease', 'client-a'), /not owned/);
    assert.throws(() => store.acknowledgeController('run-lease', 'client-a', 1), /not owned/);
    assert.throws(() => store.assertControllerOwnership('run-lease', 'client-a'), /not owned/);

    const reclaimed = store.attachController({
      runId: 'run-lease', host: 'host-b', externalThreadId: 'thread-b', clientId: 'client-b', lastAckEventId: 2
    });
    assert.equal(reclaimed.clientId, 'client-b');
    assert.equal(reclaimed.host, 'host-b');
    assert.equal(reclaimed.lastAckEventId, 2);
    store.assertControllerOwnership('run-lease', 'client-b');
    assert.equal(store.heartbeatController('run-lease', 'client-b').status, 'connected');

    store.db.prepare('UPDATE external_run_controllers SET lease_expires_at = ? WHERE run_id = ?')
      .run('2000-01-01T00:00:00.000Z', 'run-lease');
    assert.throws(() => store.assertControllerOwnership('run-lease', 'client-b'), /not owned/);
  });
});

test('rejects invalid terminal interaction transitions and empty idempotency keys', () => {
  withStore((store) => {
    const interaction = store.queueInteraction(interactionInput());
    assert.throws(() => store.answerInteraction(interaction.id, 'client-a', true, ''), /non-empty string/);
    store.claimInteraction(interaction.id, 'client-a');
    store.answerInteraction(interaction.id, 'client-a', true);
    assert.throws(() => store.cancelInteraction(interaction.id), /cannot be cancelled/);
    assert.throws(() => store.expireInteraction(interaction.id), /cannot be expired/);
    assert.throws(() => store.cancelInteraction('missing'), /not found/);
    assert.throws(() => store.expireInteraction('missing'), /not found/);
  });
});
