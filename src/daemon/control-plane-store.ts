import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

export type InteractionKind = 'approval' | 'agent_question' | 'contract_block';
export type InteractionStatus = 'queued' | 'claimed' | 'answered' | 'cancelled' | 'expired';
export type ControllerStatus = 'connected' | 'disconnected';

export interface InteractionRecord {
  id: string;
  runId: string;
  taskId: string | null;
  agentId: string;
  sessionId: string | null;
  kind: InteractionKind;
  request: JsonValue;
  status: InteractionStatus;
  claimedByClientId: string | null;
  response: JsonValue | null;
  createdAt: string;
  claimedAt: string | null;
  answeredAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  expiresAt: string | null;
  idempotencyKey: string | null;
}

export interface ControllerRecord {
  runId: string;
  host: string;
  externalThreadId: string;
  clientId: string;
  status: ControllerStatus;
  lastAckEventId: number | null;
  claimedAt: string;
  releasedAt: string | null;
}

const CONTROLLER_LEASE_DURATION_MS = 30_000;

export interface QueueInteractionInput {
  runId: string;
  taskId?: string | null;
  agentId: string;
  sessionId?: string | null;
  kind: InteractionKind;
  request: JsonValue;
  expiresAt?: string | null;
}

export interface AttachControllerInput {
  runId: string;
  host: string;
  externalThreadId: string;
  clientId: string;
  lastAckEventId?: number | null;
}

export interface WaitForInteractionAnswerOptions {
  pollIntervalMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_INTERACTION_ANSWER_POLL_INTERVAL_MS = 10;

function now(): string {
  return new Date().toISOString();
}

function normalizeTimestamp(value: string, label: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return timestamp.toISOString();
}

function assertNonNegativeEventId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function mapInteraction(row: Record<string, unknown>): InteractionRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    agentId: String(row.agent_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    kind: String(row.kind) as InteractionKind,
    request: JSON.parse(String(row.request_json)) as JsonValue,
    status: String(row.status) as InteractionStatus,
    claimedByClientId: row.claimed_by_client_id === null ? null : String(row.claimed_by_client_id),
    response: row.response_json === null ? null : JSON.parse(String(row.response_json)) as JsonValue,
    createdAt: String(row.created_at),
    claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
    answeredAt: row.answered_at === null ? null : String(row.answered_at),
    cancelledAt: row.cancelled_at === null ? null : String(row.cancelled_at),
    expiredAt: row.expired_at === null ? null : String(row.expired_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key)
  };
}

function mapController(row: Record<string, unknown>): ControllerRecord {
  return {
    runId: String(row.run_id),
    host: String(row.host),
    externalThreadId: String(row.external_thread_id),
    clientId: String(row.client_id),
    status: String(row.status) as ControllerStatus,
    lastAckEventId: row.last_ack_event_id === null ? null : Number(row.last_ack_event_id),
    claimedAt: String(row.claimed_at),
    releasedAt: row.released_at === null ? null : String(row.released_at)
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Waiting for interaction answer was aborted');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function sleepUntilAbort(
  sleep: (ms: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return sleep(milliseconds);

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(milliseconds).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** Durable ownership and human-interaction state for the local daemon. */
export class ControlPlaneStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        kind TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL,
        claimed_by_client_id TEXT,
        response_json TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        resolved_at TEXT,
        answered_at TEXT,
        cancelled_at TEXT,
        expired_at TEXT,
        expires_at TEXT,
        idempotency_key TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS external_run_controllers (
        run_id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        external_thread_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL,
        last_ack_event_id INTEGER,
        claimed_at TEXT NOT NULL,
        released_at TEXT
      ) STRICT;
    `);
    this.addColumnIfMissing('interactions', 'answered_at', 'TEXT');
    this.addColumnIfMissing('interactions', 'cancelled_at', 'TEXT');
    this.addColumnIfMissing('interactions', 'expired_at', 'TEXT');
    this.addColumnIfMissing('interactions', 'expires_at', 'TEXT');
    this.addColumnIfMissing('interactions', 'idempotency_key', 'TEXT');
    this.db.exec(`
      UPDATE interactions
      SET status = 'answered', answered_at = COALESCE(answered_at, resolved_at)
      WHERE status = 'resolved'
    `);
    this.addColumnIfMissing('external_run_controllers', 'last_heartbeat_at', 'TEXT');
    this.addColumnIfMissing('external_run_controllers', 'lease_expires_at', 'TEXT');
  }

  queueInteraction(input: QueueInteractionInput): InteractionRecord {
    const timestamp = now();
    const id = randomUUID();
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null
      ? null
      : normalizeTimestamp(input.expiresAt, 'expiresAt');
    const expired = expiresAt !== null && expiresAt <= timestamp;
    this.db.prepare(`
      INSERT INTO interactions (
        id, run_id, task_id, agent_id, session_id, kind, request_json, status,
        claimed_by_client_id, response_json, created_at, claimed_at, resolved_at,
        answered_at, cancelled_at, expired_at, expires_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)
    `).run(
      id,
      input.runId,
      input.taskId ?? null,
      input.agentId,
      input.sessionId ?? null,
      input.kind,
      JSON.stringify(input.request),
      expired ? 'expired' : 'queued',
      timestamp,
      expired ? timestamp : null,
      expiresAt
    );
    return mapInteraction(this.findInteraction(id) as Record<string, unknown>);
  }

  listInteractions(runId?: string): InteractionRecord[] {
    this.expireExpiredInteractions();
    const rows = runId === undefined
      ? this.db.prepare('SELECT * FROM interactions ORDER BY created_at, id').all()
      : this.db.prepare('SELECT * FROM interactions WHERE run_id = ? ORDER BY created_at, id').all(runId);
    return (rows as Record<string, unknown>[]).map(mapInteraction);
  }

  getInteraction(id: string): InteractionRecord {
    this.expireExpiredInteractions();
    const row = this.findInteraction(id);
    if (!row) throw new Error(`Interaction not found: ${id}`);
    return mapInteraction(row);
  }

  async waitForInteractionAnswer(
    id: string,
    options: WaitForInteractionAnswerOptions = {}
  ): Promise<JsonValue> {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_INTERACTION_ANSWER_POLL_INTERVAL_MS;
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new Error('pollIntervalMs must be a positive integer');
    }

    const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }));

    while (true) {
      throwIfAborted(options.signal);
      const interaction = this.getInteraction(id);
      if (interaction.status === 'answered') return interaction.response;
      if (interaction.status === 'cancelled' || interaction.status === 'expired') {
        throw new Error(`Interaction is ${interaction.status}: ${id}`);
      }
      await sleepUntilAbort(sleep, pollIntervalMs, options.signal);
    }
  }

  claimInteraction(id: string, clientId: string): InteractionRecord {
    this.expireExpiredInteractions();
    const row = this.db.prepare(`
      UPDATE interactions
      SET status = 'claimed', claimed_by_client_id = ?, claimed_at = ?
      WHERE id = ? AND status = 'queued'
      RETURNING *
    `).get(clientId, now(), id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Interaction is not queued: ${id}`);
    return mapInteraction(row);
  }

  answerInteraction(id: string, clientId: string, response: JsonValue, idempotencyKey?: string): InteractionRecord {
    this.expireExpiredInteractions();
    if (idempotencyKey !== undefined && idempotencyKey.length === 0) {
      throw new Error('idempotencyKey must be a non-empty string');
    }
    const responseJson = JSON.stringify(response);
    const row = this.db.prepare(`
      UPDATE interactions
      SET status = 'answered', response_json = ?, answered_at = ?, idempotency_key = ?
      WHERE id = ? AND status = 'claimed' AND claimed_by_client_id = ?
      RETURNING *
    `).get(responseJson, now(), idempotencyKey ?? null, id, clientId) as Record<string, unknown> | undefined;
    if (row) return mapInteraction(row);

    const existing = this.findInteraction(id);
    if (!existing) throw new Error(`Interaction not found: ${id}`);
    if (existing.status === 'answered'
      && existing.claimed_by_client_id === clientId
      && ((idempotencyKey !== undefined && existing.idempotency_key === idempotencyKey)
        || (idempotencyKey === undefined && existing.response_json === responseJson))) {
      return mapInteraction(existing);
    }
    throw new Error(`Interaction cannot be answered by client: ${clientId}`);
  }

  requeueClientInteractions(clientId: string): number {
    this.expireExpiredInteractions();
    return Number(this.db.prepare(`
      UPDATE interactions
      SET status = 'queued', claimed_by_client_id = NULL, claimed_at = NULL
      WHERE status = 'claimed' AND claimed_by_client_id = ?
    `).run(clientId).changes);
  }

  requeueDisconnectedControllerInteractions(): number {
    this.expireExpiredInteractions();
    return Number(this.db.prepare(`
      UPDATE interactions
      SET status = 'queued', claimed_by_client_id = NULL, claimed_at = NULL
      WHERE status = 'claimed' AND run_id IN (
        SELECT run_id FROM external_run_controllers WHERE status = 'disconnected'
      )
    `).run().changes);
  }

  attachController(input: AttachControllerInput): ControllerRecord {
    const timestamp = now();
    const leaseExpiresAt = new Date(Date.now() + CONTROLLER_LEASE_DURATION_MS).toISOString();
    if (input.lastAckEventId !== undefined && input.lastAckEventId !== null) {
      assertNonNegativeEventId(input.lastAckEventId, 'lastAckEventId');
    }
    const hasLastAckEventId = input.lastAckEventId !== undefined;
    const lastAckEventId = input.lastAckEventId ?? null;
    let row = this.db.prepare(`
      UPDATE external_run_controllers
      SET host = ?, external_thread_id = ?, client_id = ?, status = 'connected',
          last_ack_event_id = CASE WHEN ? THEN ? ELSE last_ack_event_id END,
          claimed_at = ?, released_at = NULL, last_heartbeat_at = ?, lease_expires_at = ?
      WHERE run_id = ? AND (status = 'disconnected' OR lease_expires_at < ?)
      RETURNING *
    `).get(
      input.host,
      input.externalThreadId,
      input.clientId,
      hasLastAckEventId ? 1 : 0,
        lastAckEventId,
        timestamp,
        timestamp,
        leaseExpiresAt,
        input.runId,
        timestamp
    ) as Record<string, unknown> | undefined;
    if (row) return mapController(row);

    row = this.db.prepare(`
      INSERT INTO external_run_controllers (
        run_id, host, external_thread_id, client_id, status, last_ack_event_id, claimed_at, released_at
        , last_heartbeat_at, lease_expires_at
      ) VALUES (?, ?, ?, ?, 'connected', ?, ?, NULL, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
      RETURNING *
    `).get(
      input.runId,
      input.host,
      input.externalThreadId,
      input.clientId,
        lastAckEventId,
        timestamp,
        timestamp,
        leaseExpiresAt
    ) as Record<string, unknown> | undefined;
    if (row) return mapController(row);

    row = this.db.prepare(`
      UPDATE external_run_controllers
      SET last_ack_event_id = CASE WHEN ? THEN ? ELSE last_ack_event_id END,
          last_heartbeat_at = ?, lease_expires_at = ?
      WHERE run_id = ? AND status = 'connected' AND client_id = ?
      RETURNING *
    `).get(hasLastAckEventId ? 1 : 0, lastAckEventId, timestamp, leaseExpiresAt, input.runId, input.clientId) as Record<string, unknown> | undefined;
    if (row) return mapController(row);
    throw new Error(`Run controller is owned by another client: ${input.runId}`);
  }

  getController(runId: string): ControllerRecord {
    const row = this.findController(runId);
    if (!row) throw new Error(`Run controller not found: ${runId}`);
    return mapController(row);
  }

  acknowledgeController(runId: string, clientId: string, lastAckEventId: number): ControllerRecord {
    assertNonNegativeEventId(lastAckEventId, 'lastAckEventId');
    const row = this.db.prepare(`
      UPDATE external_run_controllers
      SET last_ack_event_id = ?, last_heartbeat_at = ?, lease_expires_at = ?
      WHERE run_id = ? AND status = 'connected' AND client_id = ? AND lease_expires_at >= ?
      RETURNING *
    `).get(
      lastAckEventId,
      now(),
      new Date(Date.now() + CONTROLLER_LEASE_DURATION_MS).toISOString(),
      runId,
      clientId,
      now()
    ) as Record<string, unknown> | undefined;
    if (row) return mapController(row);

    const existing = this.findController(runId);
    if (!existing) throw new Error(`Run controller not found: ${runId}`);
    throw new Error(`Run controller is not owned by client: ${clientId}`);
  }

  disconnectController(runId: string, clientId: string): ControllerRecord {
    const row = this.db.prepare(`
      UPDATE external_run_controllers
      SET status = 'disconnected', released_at = ?
      WHERE run_id = ? AND status = 'connected' AND client_id = ?
      RETURNING *
    `).get(now(), runId, clientId) as Record<string, unknown> | undefined;
    if (row) return mapController(row);

    const existing = this.findController(runId);
    if (!existing) throw new Error(`Run controller not found: ${runId}`);
    if (existing.client_id === clientId && existing.status === 'disconnected') return mapController(existing);
    throw new Error(`Run controller is not owned by client: ${clientId}`);
  }

  heartbeatController(runId: string, clientId: string): ControllerRecord {
    const timestamp = now();
    const row = this.db.prepare(`
      UPDATE external_run_controllers
      SET last_heartbeat_at = ?, lease_expires_at = ?
      WHERE run_id = ? AND status = 'connected' AND client_id = ? AND lease_expires_at >= ?
      RETURNING *
    `).get(
      timestamp,
      new Date(Date.now() + CONTROLLER_LEASE_DURATION_MS).toISOString(),
      runId,
      clientId,
      timestamp
    ) as Record<string, unknown> | undefined;
    if (row) return mapController(row);
    throw new Error(`Run controller is not owned by client: ${clientId}`);
  }

  assertControllerOwnership(runId: string, clientId: string): void {
    const row = this.db.prepare(`
      SELECT 1 FROM external_run_controllers
      WHERE run_id = ? AND status = 'connected' AND client_id = ? AND lease_expires_at >= ?
    `).get(runId, clientId, now());
    if (!row) throw new Error(`Run controller is not owned by client: ${clientId}`);
  }

  listReconnectableRuns(): ControllerRecord[] {
    return (this.db.prepare(`
      SELECT * FROM external_run_controllers
      WHERE status = 'disconnected'
      ORDER BY run_id
    `).all() as Record<string, unknown>[]).map(mapController);
  }

  releaseExpiredControllerLeases(): number {
    return Number(this.db.prepare(`
      UPDATE external_run_controllers
      SET status = 'disconnected', released_at = ?
      WHERE status = 'connected' AND lease_expires_at < ?
    `).run(now(), now()).changes);
  }

  cancelInteraction(id: string): InteractionRecord {
    this.expireExpiredInteractions();
    const row = this.db.prepare(`
      UPDATE interactions
      SET status = 'cancelled', cancelled_at = ?
      WHERE id = ? AND status IN ('queued', 'claimed')
      RETURNING *
    `).get(now(), id) as Record<string, unknown> | undefined;
    if (row) return mapInteraction(row);

    const existing = this.findInteraction(id);
    if (!existing) throw new Error(`Interaction not found: ${id}`);
    if (existing.status === 'cancelled') return mapInteraction(existing);
    throw new Error(`Interaction cannot be cancelled: ${id}`);
  }

  expireInteraction(id: string): InteractionRecord {
    const row = this.db.prepare(`
      UPDATE interactions
      SET status = 'expired', expired_at = ?
      WHERE id = ? AND status IN ('queued', 'claimed')
      RETURNING *
    `).get(now(), id) as Record<string, unknown> | undefined;
    if (row) return mapInteraction(row);

    const existing = this.findInteraction(id);
    if (!existing) throw new Error(`Interaction not found: ${id}`);
    if (existing.status === 'expired') return mapInteraction(existing);
    throw new Error(`Interaction cannot be expired: ${id}`);
  }

  expireExpiredInteractions(): number {
    const timestamp = now();
    return Number(this.db.prepare(`
      UPDATE interactions
      SET status = 'expired', expired_at = ?
      WHERE status IN ('queued', 'claimed') AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(timestamp, timestamp).changes);
  }

  close(): void {
    this.db.close();
  }

  private findInteraction(id: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM interactions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  private findController(runId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM external_run_controllers WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
