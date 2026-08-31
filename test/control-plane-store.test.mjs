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
      kind: 'agent_question',
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
