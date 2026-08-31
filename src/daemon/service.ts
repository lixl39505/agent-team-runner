import { ensureAgentTeamHome, type AgentTeamHome } from '../core/home.js';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { StateDatabase } from '../core/db.js';
import { createExecutionRun } from '../core/execution-run.js';
import { runOrchestrator } from '../core/orchestrator.js';
import { agentList } from '../core/agent-config.js';
import type { AgentEventSink } from '../core/agent-execution.js';
import type { ContractBlockReport } from '../core/types.js';
import { validateExecutionContract } from '../core/validation.js';
import { assertAllowedCommand } from '../core/shell.js';
import { writeJson, writeTaskMarkdown } from '../core/files.js';
import type { ExecutionContract, RunManifest } from '../core/types.js';
import { ProjectRegistry, type JsonValue as ProjectJsonValue, type ProjectPolicyInput } from '../core/project-registry.js';
import { runnerConfigFromProjectPolicy } from '../core/project-runtime.js';
import type { ApprovalDecision, ApprovalHandler, UserInputAnswers, UserInputHandler } from '../agent/approval.js';
import { ControlPlaneStore, type JsonValue } from './control-plane-store.js';
import { DaemonInstanceLock, type DaemonMetadata } from './instance-lock.js';
import { LocalIpcClient, LocalIpcServer } from './ipc.js';

type RunExecutor = (input: Pick<Parameters<typeof runOrchestrator>[0],
  'config' | 'db' | 'runId' | 'requestApproval' | 'requestUserInput' | 'reportContractBlock' | 'onAgentEvent' | 'signal'
>) => Promise<void>;

type ActiveRun = {
  controller: AbortController;
  promise: Promise<void>;
};

const CANCELLED_BY_CONTROLLER = 'Cancelled by controller; run again to resume.';

export interface AgentTeamDaemonOptions {
  protocolVersion?: number;
  lock?: DaemonInstanceLock;
  server?: LocalIpcServer;
  controlPlaneStore?: ControlPlaneStore;
  projectRegistry?: ProjectRegistry;
  stateDatabase?: StateDatabase;
  /** Test seam; the default dispatches the run to the core orchestrator. */
  runExecutor?: RunExecutor;
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

function optionalNonNegativeInteger(
  params: Record<string, unknown>,
  field: string,
  method: string
): number | undefined {
  const value = params[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${method} params.${field} must be a non-negative integer`);
  }
  return value;
}

function optionalEventLimit(params: Record<string, unknown>, method: string): number | undefined {
  const value = params.limit;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error(`${method} params.limit must be an integer between 1 and 1000`);
  }
  return value;
}

function strictObject(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) throw new Error(`${label} contains unknown field: ${field}`);
  }
  return record;
}

function requiredJsonValue(value: unknown, label: string): ProjectJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new Error(`${label} must be a JSON value`);
  }
  if (Array.isArray(value)) return value.map((entry, index) => requiredJsonValue(entry, `${label}[${index}]`));
  if (value && typeof value === 'object') {
    const result: { [key: string]: ProjectJsonValue } = {};
    for (const [key, entry] of Object.entries(value)) result[key] = requiredJsonValue(entry, `${label}.${key}`);
    return result;
  }
  throw new Error(`${label} must be a JSON value`);
}

function requiredStringArray(params: Record<string, unknown>, field: string, method: string): string[] {
  const value = params[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${method} params.${field} must be an array of strings`);
  }
  return value;
}

function safeJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value, (_key, entry: unknown) => entry === undefined ? null : entry)) as JsonValue;
  } catch {
    return null;
  }
}

function safeJsonPayload(value: unknown): JsonValue {
  const seen = new WeakSet<object>();
  try {
    return JSON.parse(JSON.stringify(value, (_key, entry: unknown) => {
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') return null;
      if (typeof entry === 'bigint') return String(entry);
      if (entry && typeof entry === 'object') {
        if (seen.has(entry)) return null;
        seen.add(entry);
      }
      return entry;
    })) as JsonValue;
  } catch {
    return null;
  }
}

function isApprovalDecision(value: JsonValue): value is ApprovalDecision {
  return value === 'once' || value === 'session' || value === 'deny';
}

function isUserInputAnswers(value: JsonValue): value is UserInputAnswers {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((answers) => Array.isArray(answers) && answers.every((answer) => typeof answer === 'string'));
}

function projectPolicy(params: Record<string, unknown>): ProjectPolicyInput {
  const policy = strictObject(params.policy, 'project.register params.policy', [
    'baseRef',
    'verificationAllowedCommandPrefixes',
    'baselinePathPolicy',
    'agentProfileMapping',
    'backendPolicy'
  ]);
  return {
    baseRef: requiredString(policy, 'baseRef', 'project.register params.policy'),
    verificationAllowedCommandPrefixes: requiredStringArray(policy, 'verificationAllowedCommandPrefixes', 'project.register params.policy'),
    baselinePathPolicy: requiredJsonValue(policy.baselinePathPolicy, 'project.register params.policy.baselinePathPolicy'),
    agentProfileMapping: requiredJsonValue(policy.agentProfileMapping, 'project.register params.policy.agentProfileMapping'),
    backendPolicy: requiredJsonValue(policy.backendPolicy, 'project.register params.policy.backendPolicy')
  };
}

function assertExecutionContractFields(value: unknown): void {
  const contract = strictObject(value, 'execution.submit params.contract', ['version', 'project', 'target', 'provenance', 'tasks']);
  strictObject(contract.project, 'execution.submit params.contract.project', ['id', 'repoRoot', 'baseRef']);
  strictObject(contract.target, 'execution.submit params.contract.target', ['integrationBranch']);
  if (contract.provenance !== undefined) {
    const provenance = strictObject(contract.provenance, 'execution.submit params.contract.provenance', ['documents']);
    if (Array.isArray(provenance.documents)) {
      for (const [index, document] of provenance.documents.entries()) {
        strictObject(document, `execution.submit params.contract.provenance.documents[${index}]`, ['kind', 'locator', 'revision']);
      }
    }
  }
  if (Array.isArray(contract.tasks)) {
    for (const [index, task] of contract.tasks.entries()) {
      const taskInput = strictObject(task, `execution.submit params.contract.tasks[${index}]`, [
        'id', 'externalId', 'title', 'description', 'role', 'agent', 'dependsOn', 'allowedPaths', 'blockedPaths',
        'acceptance', 'verificationCommands', 'implementationSkills', 'implementationGuidance', 'allowNoChanges'
      ]);
      if (Array.isArray(taskInput.implementationSkills)) {
        for (const [skillIndex, skill] of taskInput.implementationSkills.entries()) {
          strictObject(skill, `execution.submit params.contract.tasks[${index}].implementationSkills[${skillIndex}]`, [
            'name', 'role', 'required', 'source'
          ]);
        }
      }
    }
  }
}

/** Owns the local daemon lifecycle and exposes its minimal IPC control surface. */
export class AgentTeamDaemon {
  private readonly lock: DaemonInstanceLock;
  private readonly protocolVersion: number;
  private readonly server: LocalIpcServer;
  private readonly controlPlaneStore: ControlPlaneStore;
  private readonly ownsControlPlaneStore: boolean;
  private readonly projectRegistry: ProjectRegistry;
  private readonly ownsProjectRegistry: boolean;
  private readonly stateDatabase: StateDatabase;
  private readonly ownsStateDatabase: boolean;
  private readonly runExecutor: RunExecutor;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private metadata: DaemonMetadata | undefined;
  private running = false;
  private stopping: Promise<void> | undefined;
  private controlPlaneStoreClosed = false;
  private projectRegistryClosed = false;
  private stateDatabaseClosed = false;

  constructor(
    private readonly home: AgentTeamHome,
    options: AgentTeamDaemonOptions = {}
  ) {
    this.protocolVersion = options.protocolVersion ?? 1;
    this.lock = options.lock ?? new DaemonInstanceLock();
    this.server = options.server ?? new LocalIpcServer();
    this.ownsControlPlaneStore = options.controlPlaneStore === undefined;
    this.controlPlaneStore = options.controlPlaneStore ?? new ControlPlaneStore(this.home.stateDb);
    this.ownsProjectRegistry = options.projectRegistry === undefined;
    this.projectRegistry = options.projectRegistry ?? new ProjectRegistry(this.home.stateDb);
    this.ownsStateDatabase = options.stateDatabase === undefined;
    this.stateDatabase = options.stateDatabase ?? new StateDatabase(this.home.stateDb);
    this.runExecutor = options.runExecutor ?? runOrchestrator;
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
      const id = requiredString(input, 'id', 'interaction.answer');
      const clientId = requiredString(input, 'clientId', 'interaction.answer');
      const interaction = this.controlPlaneStore.getInteraction(id);
      this.controlPlaneStore.assertControllerOwnership(interaction.runId, clientId);
      return this.controlPlaneStore.answerInteraction(
        id,
        clientId,
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
    this.server.register('controller.heartbeat', async (params) => {
      const input = objectParams(params, 'controller.heartbeat', ['runId', 'clientId']);
      return this.controlPlaneStore.heartbeatController(
        requiredString(input, 'runId', 'controller.heartbeat'),
        requiredString(input, 'clientId', 'controller.heartbeat')
      );
    });
    this.server.register('controller.reconnectable', async (params) => {
      if (params !== undefined) throw new Error('controller.reconnectable does not accept params');
      return this.controlPlaneStore.listReconnectableRuns();
    });
    this.server.register('project.register', async (params) => {
      const input = objectParams(params, 'project.register', ['gitCommonDir', 'repoRoot', 'displayName', 'gitIdentity', 'policy']);
      return this.projectRegistry.registerProject({
        gitCommonDir: requiredString(input, 'gitCommonDir', 'project.register'),
        repoRoot: requiredString(input, 'repoRoot', 'project.register'),
        displayName: requiredString(input, 'displayName', 'project.register'),
        gitIdentity: requiredJsonValue(input.gitIdentity, 'project.register params.gitIdentity'),
        policy: projectPolicy(input)
      });
    });
    this.server.register('project.list', async (params) => {
      if (params !== undefined) throw new Error('project.list does not accept params');
      return this.projectRegistry.listProjects();
    });
    this.server.register('execution.submit', async (params) => {
      const input = objectParams(params, 'execution.submit', ['contract', 'runId']);
      if (!Object.hasOwn(input, 'contract')) throw new Error('execution.submit params.contract is required');
      assertExecutionContractFields(input.contract);
      const contract = input.contract as Record<string, unknown>;
      const projectInput = contract.project as Record<string, unknown>;
      const project = this.projectRegistry.getProject(requiredString(projectInput, 'id', 'execution.submit params.contract.project'));
      const policy = this.projectRegistry.getProjectPolicy(project.id);
      const requestedRunId = optionalString(input, 'runId', 'execution.submit');
      const runId = await createExecutionRun({
        config: runnerConfigFromProjectPolicy(policy, project, this.home),
        db: this.stateDatabase,
        contract: input.contract,
        projectPolicyRevisionId: policy.id,
        ...(requestedRunId === undefined ? {} : { runId: requestedRunId })
      });
      return { runId, scheduled: this.scheduleRun(runId) };
    });
    this.server.register('execution.validate', async (params) => {
      const input = objectParams(params, 'execution.validate', ['contract']);
      if (!Object.hasOwn(input, 'contract')) throw new Error('execution.validate params.contract is required');
      assertExecutionContractFields(input.contract);
      const contract = input.contract as Record<string, unknown>;
      const projectInput = contract.project as Record<string, unknown>;
      const project = this.projectRegistry.getProject(requiredString(projectInput, 'id', 'execution.validate params.contract.project'));
      const policy = this.projectRegistry.getProjectPolicy(project.id);
      const config = runnerConfigFromProjectPolicy(policy, project, this.home);
      const validated = validateExecutionContract(input.contract, agentList(config).map((agent) => agent.name));
      for (const task of validated.tasks) {
        for (const command of task.verificationCommands) {
          assertAllowedCommand(command, config.verification.allowedCommandPrefixes);
        }
      }
      return { valid: true, taskCount: validated.tasks.length, projectPolicyRevisionId: policy.id };
    });
    this.server.register('execution.update_contract', async (params) => {
      const input = objectParams(params, 'execution.update_contract', ['runId', 'contract']);
      const runId = requiredString(input, 'runId', 'execution.update_contract');
      if (!Object.hasOwn(input, 'contract')) throw new Error('execution.update_contract params.contract is required');
      if (this.activeRuns.has(runId)) throw new Error(`Run ${runId} is active and cannot accept a contract revision`);
      assertExecutionContractFields(input.contract);
      const run = this.stateDatabase.getRun(runId);
      if (!run.executionContractJson || !run.projectId) throw new Error(`Run ${runId} has no external execution contract`);
      const project = this.projectRegistry.getProject(run.projectId);
      const policy = run.projectPolicyRevisionId
        ? this.projectRegistry.getProjectPolicyRevision(project.id, run.projectPolicyRevisionId)
        : this.projectRegistry.getProjectPolicy(project.id);
      const config = runnerConfigFromProjectPolicy(policy, project, this.home);
      const contract = validateExecutionContract(input.contract, agentList(config).map((agent) => agent.name));
      for (const task of contract.tasks) {
        for (const command of task.verificationCommands) assertAllowedCommand(command, config.verification.allowedCommandPrefixes);
      }
      const currentContract = JSON.parse(run.executionContractJson) as ExecutionContract;
      if (contract.project.id !== currentContract.project.id
        || contract.project.repoRoot !== currentContract.project.repoRoot
        || contract.project.baseRef !== currentContract.project.baseRef) {
        throw new Error('Contract revision cannot change the run project or base ref');
      }
      const currentTasks = this.stateDatabase.listTasks(runId);
      const proposedById = new Map(contract.tasks.map((task) => [task.id, task]));
      for (const task of currentTasks) {
        const proposed = proposedById.get(task.taskId);
        if (!proposed) throw new Error(`Contract revision cannot remove task ${task.taskId}`);
        if (task.status === 'approved' && task.specJson !== JSON.stringify(proposed)) {
          throw new Error(`Contract revision cannot change approved task ${task.taskId}`);
        }
      }
      const blocked = currentTasks.filter((task) => task.status === 'blocked_on_contract').map((task) => task.taskId);
      if (blocked.length === 0) throw new Error(`Run ${runId} has no blocked_on_contract task`);
      const affected = new Set(blocked);
      while (true) {
        const next = contract.tasks.filter((task) => task.dependsOn.some((dependency) => affected.has(dependency)));
        const additions = next.filter((task) => !affected.has(task.id));
        if (additions.length === 0) break;
        for (const task of additions) affected.add(task.id);
      }
      const currentById = new Map(currentTasks.map((task) => [task.taskId, task]));
      for (const task of contract.tasks) {
        const current = currentById.get(task.id);
        if (!current) {
          if (!task.dependsOn.some((dependency) => affected.has(dependency))) {
            throw new Error(`New task ${task.id} must depend on a contract-blocked task`);
          }
          this.stateDatabase.insertTask(runId, task);
          affected.add(task.id);
          continue;
        }
        if (!affected.has(task.id) && current.specJson !== JSON.stringify(task)) {
          throw new Error(`Contract revision can only change blocked tasks or their downstream tasks: ${task.id}`);
        }
        if (affected.has(task.id) && current.status !== 'approved') this.stateDatabase.replaceTaskSpec(runId, task);
      }
      const revision = this.stateDatabase.appendContractRevision(runId, JSON.stringify(contract));
      const manifest: RunManifest = {
        version: 1,
        title: `External execution run ${runId}`,
        summary: `Execution contract revision ${revision} for run ${runId}.`,
        tasks: contract.tasks
      };
      this.stateDatabase.updateRun(runId, {
        status: 'planned', error: null, finishedAt: null, manifestJson: JSON.stringify(manifest)
      });
      const runDir = join(this.home.runsDir, runId);
      writeJson(join(runDir, 'contract.json'), contract);
      for (const taskId of affected) {
        const task = proposedById.get(taskId)!;
        writeTaskMarkdown(join(runDir, 'tasks', `${task.id}.md`), task, run.baseSha);
      }
      this.stateDatabase.addEvent(runId, null, 'EXECUTION_CONTRACT_UPDATED', { revision, affectedTaskIds: [...affected].sort() });
      return { runId, revision, affectedTaskIds: [...affected].sort(), scheduled: this.scheduleRun(runId) };
    });
    this.server.register('execution.list', async (params) => {
      if (params === undefined) return this.stateDatabase.listRuns();
      const input = objectParams(params, 'execution.list', ['projectId']);
      const projectId = optionalString(input, 'projectId', 'execution.list');
      return this.stateDatabase.listRuns().filter((run) => projectId === undefined || run.projectId === projectId);
    });
    this.server.register('execution.start', async (params) => {
      const input = objectParams(params, 'execution.start', ['runId']);
      const runId = requiredString(input, 'runId', 'execution.start');
      return { runId, scheduled: this.scheduleRun(runId) };
    });
    this.server.register('execution.cancel', async (params) => {
      const input = objectParams(params, 'execution.cancel', ['runId']);
      const runId = requiredString(input, 'runId', 'execution.cancel');
      const activeRun = this.activeRuns.get(runId);
      // Abort first: the orchestrator synchronously marks an interrupted run as running.
      // Persisting controller cancellation afterwards prevents automatic recovery on restart.
      activeRun?.controller.abort();
      this.markRunCancelled(runId);
      return { runId, cancelled: true };
    });
    this.server.register('execution.get', async (params) => {
      const input = objectParams(params, 'execution.get', ['runId']);
      const runId = requiredString(input, 'runId', 'execution.get');
      return {
        run: this.stateDatabase.getRun(runId),
        tasks: this.stateDatabase.listTasks(runId),
        agentExecutions: this.stateDatabase.listAgentExecutions(runId)
      };
    });
    this.server.register('execution.handoff', async (params) => {
      const input = objectParams(params, 'execution.handoff', ['runId']);
      const runId = requiredString(input, 'runId', 'execution.handoff');
      const path = join(this.home.runsDir, runId, 'handoff.json');
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          throw new Error(`Run ${runId} has no handoff; it must complete before handoff is available`);
        }
        throw error;
      }
    });
    this.server.register('execution.events', async (params) => {
      const input = objectParams(params, 'execution.events', ['runId', 'clientId', 'afterEventId', 'limit']);
      const runId = requiredString(input, 'runId', 'execution.events');
      const clientId = requiredString(input, 'clientId', 'execution.events');
      const requestedAfterEventId = optionalNonNegativeInteger(input, 'afterEventId', 'execution.events');
      const limit = optionalEventLimit(input, 'execution.events');
      const controller = this.controlPlaneStore.getController(runId);
      const afterEventId = requestedAfterEventId ?? controller.lastAckEventId ?? 0;

      // Returning an event is not an acknowledgement; only afterEventId advances the durable cursor.
      this.controlPlaneStore.acknowledgeController(runId, clientId, afterEventId);
      const events = this.stateDatabase.listEvents(runId, afterEventId, limit);
      return { events, lastEventId: events.at(-1)?.id ?? afterEventId };
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
      for (const run of this.stateDatabase.listRuns()) {
        if (run.adapter === 'external'
          && (run.status === 'planned' || run.status === 'running')
          && run.projectId !== null
          && run.projectPolicyRevisionId !== null) {
          this.scheduleRun(run.id);
        }
      }
    } catch (error) {
      this.lock.release();
      this.metadata = undefined;
      this.closeOwnedResources();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.running) {
      this.closeOwnedResources();
      return;
    }

    this.running = false;
    const stopping = (async () => {
      try {
        const activeRuns = [...this.activeRuns.values()];
        for (const activeRun of activeRuns) activeRun.controller.abort();
        await this.server.stop();
        await Promise.allSettled(activeRuns.map((activeRun) => activeRun.promise));
      } finally {
        this.lock.release();
        this.metadata = undefined;
        this.closeOwnedResources();
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

  private scheduleRun(runId: string): boolean {
    if (this.activeRuns.has(runId)) return false;
    const run = this.stateDatabase.getRun(runId);
    if (!['planned', 'running', 'needs_attention', 'failed'].includes(run.status)) {
      throw new Error(`Run ${runId} cannot be scheduled from status ${run.status}`);
    }
    if (!run.projectId || !run.projectPolicyRevisionId) {
      throw new Error(`Run ${runId} has no persistent project policy; legacy runs cannot be scheduled`);
    }
    const project = this.projectRegistry.getProject(run.projectId);
    const policy = this.projectRegistry.getProjectPolicyRevision(project.id, run.projectPolicyRevisionId);
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(async () => {
        await this.runExecutor({
          config: runnerConfigFromProjectPolicy(policy, project, this.home),
          db: this.stateDatabase,
          runId,
          requestApproval: this.requestApproval(runId),
          requestUserInput: this.requestUserInput(runId),
          reportContractBlock: this.reportContractBlock(runId),
          onAgentEvent: this.onAgentEvent(runId),
          signal: controller.signal
        });
        this.writeHandoff(runId);
      })
      .catch((error: unknown) => {
        const latest = this.stateDatabase.getRun(runId);
        if (latest.status !== 'done' && latest.status !== 'needs_attention') {
          this.stateDatabase.updateRun(runId, { status: 'failed', error: String(error), finishedAt: new Date().toISOString() });
          this.stateDatabase.addEvent(runId, null, 'RUN_DAEMON_FAILED', { error: String(error) });
        }
      })
      .finally(() => this.activeRuns.delete(runId));
    this.activeRuns.set(runId, { controller, promise });
    return true;
  }

  private markRunCancelled(runId: string): void {
    const run = this.stateDatabase.getRun(runId);
    if (run.status === 'done') throw new Error(`Run ${runId} cannot be cancelled from status done`);
    if (run.status === 'needs_attention' && run.error === CANCELLED_BY_CONTROLLER) return;
    this.stateDatabase.updateRun(runId, { status: 'needs_attention', error: CANCELLED_BY_CONTROLLER });
    this.stateDatabase.addEvent(runId, null, 'RUN_CANCELLED');
  }

  private requestApproval(runId: string): ApprovalHandler {
    return async (request, signal) => {
      const interaction = this.controlPlaneStore.queueInteraction({
        runId,
        taskId: null,
        agentId: `${request.role}:${request.backend}`,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        kind: 'approval',
        request: safeJsonValue(request)
      });
      const answer = await this.controlPlaneStore.waitForInteractionAnswer(
        interaction.id,
        signal === undefined ? {} : { signal }
      );
      if (!isApprovalDecision(answer)) throw new Error(`Invalid approval response for interaction ${interaction.id}`);
      return answer;
    };
  }

  private requestUserInput(runId: string): UserInputHandler {
    return async (request, signal) => {
      const interaction = this.controlPlaneStore.queueInteraction({
        runId,
        taskId: null,
        agentId: `${request.role}:${request.backend}`,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        kind: 'agent_question',
        request: safeJsonValue(request)
      });
      const answer = await this.controlPlaneStore.waitForInteractionAnswer(
        interaction.id,
        signal === undefined ? {} : { signal }
      );
      if (!isUserInputAnswers(answer)) throw new Error(`Invalid user input response for interaction ${interaction.id}`);
      return answer;
    };
  }

  private reportContractBlock(runId: string): (report: ContractBlockReport) => void {
    return (report) => {
      try {
        const task = JSON.parse(report.task.specJson) as { externalId?: unknown };
        this.controlPlaneStore.queueInteraction({
          runId,
          taskId: report.task.taskId,
          agentId: report.agentExecution.agentId,
          sessionId: report.agentExecution.sessionId,
          kind: 'contract_block',
          request: safeJsonPayload({
            type: 'blocked_on_contract',
            taskId: report.task.taskId,
            task: { title: report.task.title, externalId: task.externalId ?? null },
            attempt: report.task.attempts,
            reason: report.reason
          })
        });
      } catch {
        // Contract escalation must not turn a blocked task into an orchestrator exception.
      }
    };
  }

  private onAgentEvent(runId: string): AgentEventSink {
    return (execution, event) => {
      if (event.type === 'activity') return;
      try {
        this.stateDatabase.addEvent(runId, execution.taskId ?? null, 'AGENT_EVENT', safeJsonPayload({ execution, event }));
      } catch {
        // Observability failures must not interrupt the agent execution.
      }
    };
  }

  private writeHandoff(runId: string): void {
    const run = this.stateDatabase.getRun(runId);
    if (run.status !== 'done') return;
    const tasks = this.stateDatabase.listTasks(runId);
    const handoff = {
      version: 1,
      run: {
        id: run.id,
        projectId: run.projectId,
        projectPolicyRevisionId: run.projectPolicyRevisionId,
        contractRevision: run.contractRevision,
        status: run.status,
        baseRef: run.baseRef,
        baseSha: run.baseSha,
        integrationBranch: run.integrationBranch,
        integrationCommit: run.integrationCommit
      },
      tasks: tasks.map((task) => ({
        id: task.taskId,
        title: task.title,
        status: task.status,
        commitSha: task.commitSha,
        attempts: task.attempts,
        review: task.reviewJson === null ? null : JSON.parse(task.reviewJson),
        lastError: task.lastError
      })),
      contract: run.executionContractJson === null ? null : JSON.parse(run.executionContractJson)
    };
    const runDir = join(this.home.runsDir, runId);
    writeJson(join(runDir, 'handoff.json'), handoff);
    const lines = [
      `# Run Handoff: ${runId}`,
      '',
      `- Status: ${run.status}`,
      `- Integration branch: ${run.integrationBranch ?? 'none'}`,
      `- Integration commit: ${run.integrationCommit ?? 'none'}`,
      `- Contract revision: ${run.contractRevision}`,
      '',
      '## Tasks',
      ...tasks.map((task) => `- ${task.taskId}: ${task.status}${task.commitSha ? ` (${task.commitSha})` : ''}`)
    ];
    writeFileSync(join(runDir, 'handoff.md'), `${lines.join('\n')}\n`, 'utf8');
    this.stateDatabase.addEvent(runId, null, 'RUN_HANDOFF_CREATED', { path: join(runDir, 'handoff.json') });
  }

  private closeOwnedResources(): void {
    this.closeOwnedControlPlaneStore();
    if (this.ownsProjectRegistry && !this.projectRegistryClosed) {
      this.projectRegistry.close();
      this.projectRegistryClosed = true;
    }
    if (this.ownsStateDatabase && !this.stateDatabaseClosed) {
      this.stateDatabase.close();
      this.stateDatabaseClosed = true;
    }
  }
}

export async function connectToDaemon(home: AgentTeamHome): Promise<LocalIpcClient> {
  const client = new LocalIpcClient(home.socket);
  await client.connect();
  return client;
}
