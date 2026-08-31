import { ensureAgentTeamHome, type AgentTeamHome } from '../core/home.js';
import { ControlPlaneStore, type JsonValue } from './control-plane-store.js';
import { DaemonInstanceLock, type DaemonMetadata } from './instance-lock.js';
import { LocalIpcClient, LocalIpcServer } from './ipc.js';

export interface AgentTeamDaemonOptions {
  protocolVersion?: number;
  lock?: DaemonInstanceLock;
  server?: LocalIpcServer;
  controlPlaneStore?: ControlPlaneStore;
}

function objectParams(params: unknown, method: string, fields: readonly string[]): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`${method} params must be an object`);
  }
  const record = params as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) throw new Error(`${method} params contains unknown field: ${field}`);
  }
  return record;
}

function requiredString(params: Record<string, unknown>, field: string, method: string): string {
  const value = params[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${method} params.${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(params: Record<string, unknown>, field: string, method: string): string | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${method} params.${field} must be a non-empty string`);
  }
  return value;
}

function optionalEventId(params: Record<string, unknown>, method: string): number | null | undefined {
  const value = params.lastAckEventId;
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${method} params.lastAckEventId must be a non-negative integer or null`);
  }
  return value;
}

/** Owns the local daemon lifecycle and exposes its minimal IPC control surface. */
export class AgentTeamDaemon {
  private readonly lock: DaemonInstanceLock;
  private readonly protocolVersion: number;
  private readonly server: LocalIpcServer;
  private readonly controlPlaneStore: ControlPlaneStore;
  private readonly ownsControlPlaneStore: boolean;
  private metadata: DaemonMetadata | undefined;
  private running = false;
  private stopping: Promise<void> | undefined;
  private controlPlaneStoreClosed = false;

  constructor(
    private readonly home: AgentTeamHome,
    options: AgentTeamDaemonOptions = {}
  ) {
    this.protocolVersion = options.protocolVersion ?? 1;
    this.lock = options.lock ?? new DaemonInstanceLock();
    this.server = options.server ?? new LocalIpcServer();
    this.ownsControlPlaneStore = options.controlPlaneStore === undefined;
    this.controlPlaneStore = options.controlPlaneStore ?? new ControlPlaneStore(this.home.stateDb);
    this.server.register('health', async () => ({
      metadata: this.metadata,
      home: this.home.root,
      protocolVersion: this.protocolVersion
    }));
    this.server.register('shutdown', async () => {
      // Let the request response be written before closing its IPC connection.
      setImmediate(() => { void this.stop(); });
      return { accepted: true };
    });
    this.server.register('interaction.list', async (params) => {
      if (params === undefined) return this.controlPlaneStore.listInteractions();
      const input = objectParams(params, 'interaction.list', ['runId']);
      return this.controlPlaneStore.listInteractions(optionalString(input, 'runId', 'interaction.list'));
    });
    this.server.register('interaction.claim', async (params) => {
      const input = objectParams(params, 'interaction.claim', ['id', 'clientId']);
      return this.controlPlaneStore.claimInteraction(
        requiredString(input, 'id', 'interaction.claim'),
        requiredString(input, 'clientId', 'interaction.claim')
      );
    });
    this.server.register('interaction.answer', async (params) => {
      const input = objectParams(params, 'interaction.answer', ['id', 'clientId', 'response']);
      if (!Object.hasOwn(input, 'response')) {
        throw new Error('interaction.answer params.response is required');
      }
      return this.controlPlaneStore.answerInteraction(
        requiredString(input, 'id', 'interaction.answer'),
        requiredString(input, 'clientId', 'interaction.answer'),
        input.response as JsonValue
      );
    });
    this.server.register('interaction.requeue_client', async (params) => {
      const input = objectParams(params, 'interaction.requeue_client', ['clientId']);
      return this.controlPlaneStore.requeueClientInteractions(
        requiredString(input, 'clientId', 'interaction.requeue_client')
      );
    });
    this.server.register('controller.attach', async (params) => {
      const input = objectParams(params, 'controller.attach', [
        'runId', 'host', 'externalThreadId', 'clientId', 'lastAckEventId'
      ]);
      const runId = requiredString(input, 'runId', 'controller.attach');
      const lastAckEventId = optionalEventId(input, 'controller.attach');
      return this.controlPlaneStore.attachController({
        runId,
        host: requiredString(input, 'host', 'controller.attach'),
        externalThreadId: optionalString(input, 'externalThreadId', 'controller.attach') ?? runId,
        clientId: requiredString(input, 'clientId', 'controller.attach'),
        ...(lastAckEventId === undefined ? {} : { lastAckEventId })
      });
    });
    this.server.register('controller.disconnect', async (params) => {
      const input = objectParams(params, 'controller.disconnect', ['runId', 'clientId']);
      return this.controlPlaneStore.disconnectController(
        requiredString(input, 'runId', 'controller.disconnect'),
        requiredString(input, 'clientId', 'controller.disconnect')
      );
    });
    this.server.register('controller.reconnectable', async (params) => {
      if (params !== undefined) throw new Error('controller.reconnectable does not accept params');
      return this.controlPlaneStore.listReconnectableRuns();
    });
  }

  async start(): Promise<void> {
    if (this.running) return;

    ensureAgentTeamHome(this.home);
    const metadata: DaemonMetadata = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      protocolVersion: this.protocolVersion
    };
    this.metadata = metadata;
    this.lock.acquire(this.home, metadata);
    try {
      await this.server.start(this.home.socket);
      this.running = true;
    } catch (error) {
      this.lock.release();
      this.metadata = undefined;
      this.closeOwnedControlPlaneStore();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.running) {
      this.closeOwnedControlPlaneStore();
      return;
    }

    this.running = false;
    const stopping = (async () => {
      try {
        await this.server.stop();
      } finally {
        this.lock.release();
        this.metadata = undefined;
        this.closeOwnedControlPlaneStore();
      }
    })();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      this.stopping = undefined;
    }
  }

  private closeOwnedControlPlaneStore(): void {
    if (!this.ownsControlPlaneStore || this.controlPlaneStoreClosed) return;
    this.controlPlaneStore.close();
    this.controlPlaneStoreClosed = true;
  }
}

export async function connectToDaemon(home: AgentTeamHome): Promise<LocalIpcClient> {
  const client = new LocalIpcClient(home.socket);
  await client.connect();
  return client;
}
