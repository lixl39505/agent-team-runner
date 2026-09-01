import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AgentTeamHome } from '../core/home.js';
import { LocalIpcClient } from '../daemon/ipc.js';

type IpcRequester = Pick<LocalIpcClient, 'request'>;

/** Keeps MCP stdio alive while the independently managed daemon restarts. */
class ReconnectingIpcRequester implements IpcRequester {
  private client: LocalIpcClient | undefined;
  private connecting: Promise<LocalIpcClient> | undefined;

  constructor(private readonly socket: string) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    try {
      return await (await this.connectedClient()).request(method, params);
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  close(): void {
    this.reset();
  }

  private async connectedClient(): Promise<LocalIpcClient> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const client = new LocalIpcClient(this.socket);
    this.connecting = client.connect().then(() => {
      this.client = client;
      return client;
    }).catch((error: unknown) => {
      client.close();
      throw error;
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private reset(): void {
    this.client?.close();
    this.client = undefined;
  }
}

type Interaction = {
  id: string;
  kind: 'approval' | 'agent_question' | 'contract_block';
  request: Record<string, unknown>;
  status: string;
};

type DurableEvent = {
  id: number;
  runId: string;
  eventType: string;
  createdAt: string;
};

export interface McpGatewayOptions {
  /** Test seam; production checks the daemon's durable stream every second. */
  pollIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

const emptyInput = z.object({}).strict();
const nonEmptyString = z.string().min(1);
const jsonValue = z.json();

const projectPolicyInput = z.object({
  baseRef: nonEmptyString,
  verificationAllowedCommandPrefixes: z.array(z.string()),
  baselinePathPolicy: jsonValue,
  agentProfileMapping: jsonValue,
  backendPolicy: jsonValue
}).strict();

const projectRegistrationInput = z.object({
  gitCommonDir: nonEmptyString,
  repoRoot: nonEmptyString,
  displayName: nonEmptyString,
  gitIdentity: jsonValue,
  policy: projectPolicyInput,
  createdBy: nonEmptyString.optional(),
  note: nonEmptyString.optional()
}).strict();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null)!;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function interaction(value: unknown): Interaction | undefined {
  const candidate = record(value);
  if (typeof candidate.id !== 'string'
    || (candidate.kind !== 'approval' && candidate.kind !== 'agent_question' && candidate.kind !== 'contract_block')
    || typeof candidate.status !== 'string') return undefined;
  return { id: candidate.id, kind: candidate.kind, request: record(candidate.request), status: candidate.status };
}

function durableEvent(value: unknown): DurableEvent | undefined {
  const candidate = record(value);
  if (typeof candidate.id !== 'number' || !Number.isSafeInteger(candidate.id) || candidate.id < 0
    || typeof candidate.runId !== 'string' || typeof candidate.eventType !== 'string' || typeof candidate.createdAt !== 'string') {
    return undefined;
  }
  return { id: candidate.id, runId: candidate.runId, eventType: candidate.eventType, createdAt: candidate.createdAt };
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function approvalElicitation(request: Record<string, unknown>) {
  const allowSession = request.allowSession === true;
  return {
    mode: 'form' as const,
    // MCP form elicitation is restricted to non-sensitive data. Do not forward tool input or backend-provided prose.
    message: `${text(request.tool, 'Agent tool')} requests ${text(request.kind, 'an operation')} approval. Choose whether to allow it.`,
    requestedSchema: {
      type: 'object' as const,
      properties: {
        decision: {
          type: 'string' as const,
          title: 'Decision',
          oneOf: [
            { const: 'once', title: 'Allow once' },
            ...(allowSession ? [{ const: 'session', title: 'Allow for this session' }] : []),
            { const: 'deny', title: 'Deny' }
          ]
        }
      },
      required: ['decision']
    }
  };
}

type QuestionField = { key: string; id: string; multiple: boolean; allowCustom: boolean; options: string[] };

function questionElicitation(request: Record<string, unknown>): { params: ElicitRequestFormParams; fields: QuestionField[] } | undefined {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  if (questions.length === 0) return undefined;
  const fields: QuestionField[] = [];
  const properties: ElicitRequestFormParams['requestedSchema']['properties'] = {};
  for (const [index, value] of questions.entries()) {
    const question = record(value);
    if (typeof question.id !== 'string' || question.id.length === 0 || question.secret === true) return undefined;
    const options = Array.isArray(question.options)
      ? question.options.map(record).map((option) => option.label).filter((label): label is string => typeof label === 'string' && label.length > 0)
      : [];
    const key = `answer_${index + 1}`;
    const multiple = question.multiple === true;
    const allowCustom = question.allowCustom === true;
    properties[key] = options.length > 0 && !multiple && !allowCustom
      ? { type: 'string', title: text(question.header, text(question.question, `Question ${index + 1}`)), oneOf: options.map((option) => ({ const: option, title: option })) }
      : multiple && options.length > 0
        ? { type: 'string', title: text(question.header, text(question.question, `Question ${index + 1}`)), description: 'Enter comma-separated choices.' }
        : { type: 'string', title: text(question.header, text(question.question, `Question ${index + 1}`)) };
    fields.push({ key, id: question.id, multiple, allowCustom, options });
  }
  return {
    params: {
      mode: 'form',
      message: `Agent question from ${text(request.backend, 'agent')}.`,
      requestedSchema: { type: 'object', properties, required: fields.map((field) => field.key) }
    },
    fields
  };
}

function questionAnswer(content: unknown, fields: readonly QuestionField[]): Record<string, string[]> | undefined {
  const values = record(content);
  const answer: Record<string, string[]> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
    const choices = field.multiple ? raw.split(',').map((choice) => choice.trim()).filter(Boolean) : [raw];
    if (choices.length === 0 || (!field.allowCustom && field.options.length > 0 && choices.some((choice) => !field.options.includes(choice)))) {
      return undefined;
    }
    answer[field.id] = choices;
  }
  return answer;
}

/** Bridges one MCP connection to durable daemon events and eligible human interactions. */
class McpGateway {
  private readonly attached = new Map<string, string>();
  private readonly skippedInteractions = new Set<string>();
  private readonly abort = new AbortController();
  private interval: NodeJS.Timeout | undefined;
  private eventCursor = 0;
  private refreshing = false;
  private closed = false;

  constructor(
    private readonly ipc: IpcRequester,
    private readonly server: McpServer,
    private readonly options: McpGatewayOptions
  ) {}

  start(): void {
    if (this.closed || this.interval) return;
    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error('pollIntervalMs must be a positive integer');
    this.interval = (this.options.setInterval ?? setInterval)(() => { void this.refresh(); }, pollIntervalMs);
    this.interval.unref?.();
  }

  attach(runId: string, clientId: string): void {
    this.attached.set(runId, clientId);
    if (this.supportsFormElicitation()) void this.refresh();
  }

  detach(runId: string, clientId: string): void {
    if (this.attached.get(runId) === clientId) this.attached.delete(runId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort(new Error('MCP connection closed'));
    if (this.interval) (this.options.clearInterval ?? clearInterval)(this.interval);
    this.interval = undefined;
    const controllers = [...this.attached.entries()];
    const clients = [...new Set(controllers.map(([, clientId]) => clientId))];
    this.attached.clear();
    await Promise.allSettled(clients.map(async (clientId) => {
      await this.ipc.request('interaction.requeue_client', { clientId });
    }));
    await Promise.allSettled(controllers.map(async ([runId, clientId]) => {
      await this.ipc.request('controller.disconnect', { runId, clientId });
    }));
  }

  private async refresh(): Promise<void> {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      await this.sendRunNotifications();
      await this.elicitQueuedInteractions();
    } catch {
      // Durable state remains authoritative; the next interval or attach session can retry.
    } finally {
      this.refreshing = false;
    }
  }

  private async sendRunNotifications(): Promise<void> {
    const result = record(await this.ipc.request('execution.events_since', { afterEventId: this.eventCursor, limit: 1000 }));
    const events = Array.isArray(result.events) ? result.events.map(durableEvent).filter((event): event is DurableEvent => event !== undefined) : [];
    for (const event of events) {
      this.eventCursor = Math.max(this.eventCursor, event.id);
      const status = runStatus(event.eventType);
      if (event.eventType === 'RUN_HANDOFF_CREATED') {
        await this.server.server.sendLoggingMessage({
          level: 'info', logger: 'agent-team.run', data: { type: 'run.completed', handoff: { runId: event.runId, available: true } }
        });
      } else if (status) {
        await this.server.server.sendLoggingMessage({
          level: 'info', logger: 'agent-team.run', data: {
            type: 'run.status', runId: event.runId, status, eventId: event.id, eventType: event.eventType, createdAt: event.createdAt
          }
        });
      }
    }
  }

  private async elicitQueuedInteractions(): Promise<void> {
    if (!this.supportsFormElicitation()) return;
    for (const [runId, clientId] of this.attached) {
      if (this.closed) return;
      const value = await this.ipc.request('interaction.list', { runId });
      const queued = Array.isArray(value) ? value.map(interaction).filter((item): item is Interaction => item?.status === 'queued') : [];
      for (const item of queued) {
        if (item.kind === 'contract_block' || this.skippedInteractions.has(item.id)) continue;
        await this.elicitInteraction(item, clientId);
        return; // One form at a time keeps claims and failure recovery unambiguous.
      }
    }
  }

  private supportsFormElicitation(): boolean {
    return this.server.server.getClientCapabilities()?.elicitation?.form !== undefined;
  }

  private async elicitInteraction(item: Interaction, clientId: string): Promise<void> {
    try {
      await this.ipc.request('interaction.claim', { id: item.id, clientId });
    } catch {
      return; // Another controller won it; the next durable refresh is authoritative.
    }
    try {
      if (item.kind === 'approval') {
        const result = await this.server.server.elicitInput(approvalElicitation(item.request), { signal: this.abort.signal });
        const decision = record(result.content).decision;
        if (result.action === 'accept' && (decision === 'once' || decision === 'session' || decision === 'deny')) {
          await this.ipc.request('interaction.answer', { id: item.id, clientId, response: decision, idempotencyKey: `mcp:${item.id}` });
          return;
        }
        if (result.action === 'decline') {
          await this.ipc.request('interaction.answer', { id: item.id, clientId, response: 'deny', idempotencyKey: `mcp:${item.id}` });
          return;
        }
      } else {
        const elicitation = questionElicitation(item.request);
        if (elicitation) {
          const result = await this.server.server.elicitInput(elicitation.params, { signal: this.abort.signal });
          const answer = result.action === 'accept' ? questionAnswer(result.content, elicitation.fields) : undefined;
          if (answer) {
            await this.ipc.request('interaction.answer', { id: item.id, clientId, response: answer, idempotencyKey: `mcp:${item.id}` });
            return;
          }
        }
      }
    } catch {
      // Requeue below. A client transport failure must not strand a daemon interaction.
    }
    this.skippedInteractions.add(item.id);
    await this.ipc.request('interaction.requeue_client', { clientId }).catch(() => {});
  }
}

function runStatus(eventType: string): string | undefined {
  switch (eventType) {
    case 'RUN_CREATED': return 'planned';
    case 'RUN_STARTED': return 'running';
    case 'RUN_PAUSED': return 'paused';
    case 'RUN_CANCELLED': return 'cancelled';
    case 'RUN_FAILED':
    case 'RUN_DAEMON_FAILED': return 'failed';
    default: return undefined;
  }
}

async function requestTool(ipc: IpcRequester, method: string, params?: unknown) {
  try {
    const result = params === undefined
      ? await ipc.request(method)
      : await ipc.request(method, params);
    return {
      content: [{ type: 'text' as const, text: jsonText(result) }],
      structuredContent: { result: result ?? null }
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: errorMessage(error) }],
      isError: true
    };
  }
}

/** Creates the MCP control-plane bridge for a daemon IPC requester. */
export function createMcpServer(ipc: IpcRequester, options: McpGatewayOptions = {}): McpServer {
  const server = new McpServer({ name: 'agent-team', version: '0.1.0' }, { capabilities: { logging: {} } });
  const gateway = new McpGateway(ipc, server, options);
  server.server.oninitialized = () => gateway.start();
  server.server.onclose = () => { void gateway.close(); };

  server.registerTool('agent_team_get_status', {
    description: 'Get local agent-team daemon health and status.',
    inputSchema: emptyInput
  }, () => requestTool(ipc, 'health'));

  server.registerTool('agent_team_list_interactions', {
    description: 'List queued, claimed, answered, cancelled, and expired interactions, optionally for one run.',
    inputSchema: z.object({ runId: nonEmptyString.optional() }).strict()
  }, (input) => requestTool(
    ipc,
    'interaction.list',
    input.runId === undefined ? undefined : { runId: input.runId }
  ));

  server.registerTool('agent_team_claim_interaction', {
    description: 'Claim a queued interaction for a controller client.',
    inputSchema: z.object({ id: nonEmptyString, clientId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'interaction.claim', input));

  server.registerTool('agent_team_answer_interaction', {
    description: 'Answer an interaction claimed by the controller client.',
    inputSchema: z.object({
      id: nonEmptyString,
      clientId: nonEmptyString,
      response: z.json(),
      idempotencyKey: nonEmptyString.optional()
    }).strict()
  }, (input) => requestTool(ipc, 'interaction.answer', input));

  server.registerTool('agent_team_requeue_interactions', {
    description: 'Requeue every interaction claimed by a controller client.',
    inputSchema: z.object({ clientId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'interaction.requeue_client', input));

  server.registerTool('agent_team_attach_controller', {
    description: 'Attach a controller client to a run.',
    inputSchema: z.object({
      runId: nonEmptyString,
      host: nonEmptyString,
      externalThreadId: nonEmptyString.optional(),
      clientId: nonEmptyString,
      lastAckEventId: z.number().int().nonnegative().nullable().optional()
    }).strict()
  }, async (input) => {
    const result = await requestTool(ipc, 'controller.attach', input);
    if (!result.isError) gateway.attach(input.runId, input.clientId);
    return result;
  });

  server.registerTool('agent_team_disconnect_controller', {
    description: 'Disconnect a controller client from a run.',
    inputSchema: z.object({ runId: nonEmptyString, clientId: nonEmptyString }).strict()
  }, async (input) => {
    const result = await requestTool(ipc, 'controller.disconnect', input);
    if (!result.isError) gateway.detach(input.runId, input.clientId);
    return result;
  });

  server.registerTool('agent_team_heartbeat_controller', {
    description: 'Renew the temporary ownership lease for an attached run controller.',
    inputSchema: z.object({ runId: nonEmptyString, clientId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'controller.heartbeat', input));

  server.registerTool('agent_team_list_reconnectable_runs', {
    description: 'List runs whose controllers can reconnect.',
    inputSchema: z.object({ projectId: nonEmptyString.optional() }).strict()
  }, (input) => requestTool(
    ipc,
    'controller.reconnectable',
    input.projectId === undefined ? undefined : { projectId: input.projectId }
  ));

  server.registerTool('agent_team_get_host_capabilities', {
    description: 'Read the explicit, Host-specific capability registry. Unverified capabilities are not enabled.',
    inputSchema: z.object({ host: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'host.capabilities', input));

  server.registerTool('agent_team_resume_external_thread', {
    description: 'Explicitly request a declared Host adapter to resume this controller thread; durable context remains the fallback.',
    inputSchema: z.object({ runId: nonEmptyString, clientId: nonEmptyString, explicitlyRequested: z.literal(true) }).strict()
  }, (input) => requestTool(ipc, 'controller.resume_external_thread', input));

  server.registerTool('agent_team_start_review_turn', {
    description: 'Explicitly request a declared Host adapter to start an outer review turn; durable context remains the fallback.',
    inputSchema: z.object({ runId: nonEmptyString, clientId: nonEmptyString, explicitlyRequested: z.literal(true) }).strict()
  }, (input) => requestTool(ipc, 'controller.start_review_turn', input));

  server.registerTool('agent_team_register_project', {
    description: 'Register a repository and its execution policy.',
    inputSchema: projectRegistrationInput
  }, (input) => requestTool(ipc, 'project.register', input));

  server.registerTool('agent_team_list_projects', {
    description: 'List registered projects; archived projects are hidden unless requested.',
    inputSchema: z.object({ includeArchived: z.boolean().optional() }).strict()
  }, (input) => requestTool(
    ipc,
    'project.list',
    input.includeArchived === undefined ? undefined : { includeArchived: input.includeArchived }
  ));

  server.registerTool('agent_team_archive_project', {
    description: 'Archive a registered project so it is hidden from the default project list.',
    inputSchema: z.object({ projectId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'project.archive', input));

  server.registerTool('agent_team_list_project_skills', {
    description: 'List safe project-local implementation Skills available to execution contracts.',
    inputSchema: z.object({ projectId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'project.skills', input));

  server.registerTool('agent_team_submit_execution_contract', {
    description: 'Submit a validated execution contract for a registered project.',
    inputSchema: z.object({
      contract: jsonValue,
      runId: nonEmptyString.optional()
    }).strict()
  }, (input) => requestTool(ipc, 'execution.submit', input));

  server.registerTool('agent_team_validate_execution_contract', {
    description: 'Validate an execution contract against the registered project policy without creating a run.',
    inputSchema: z.object({ contract: jsonValue }).strict()
  }, (input) => requestTool(ipc, 'execution.validate', input));

  server.registerTool('agent_team_list_runs', {
    description: 'List daemon runs, optionally limited to one project.',
    inputSchema: z.object({ projectId: nonEmptyString.optional() }).strict()
  }, (input) => requestTool(
    ipc,
    'execution.list',
    input.projectId === undefined ? undefined : { projectId: input.projectId }
  ));

  server.registerTool('agent_team_update_task_contract', {
    description: 'Apply a revised execution contract to a run blocked on contract scope or requirements.',
    inputSchema: z.object({ runId: nonEmptyString, contract: jsonValue }).strict()
  }, (input) => requestTool(ipc, 'execution.update_contract', input));

  server.registerTool('agent_team_start_run', {
    description: 'Start or resume an execution run.',
    inputSchema: z.object({ runId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'execution.start', input));

  server.registerTool('agent_team_pause_run', {
    description: 'Pause an active execution run without cancelling its contract.',
    inputSchema: z.object({ runId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'execution.pause', input));

  server.registerTool('agent_team_cancel_run', {
    description: 'Cancel an execution run so it can be resumed later.',
    inputSchema: z.object({ runId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'execution.cancel', input));

  server.registerTool('agent_team_get_run', {
    description: 'Get a run, its tasks, and its agent executions.',
    inputSchema: z.object({ runId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'execution.get', input));

  server.registerTool('agent_team_read_agent_log', {
    description: 'Read a bounded tail of an agent log recorded for a run. File paths cannot be supplied.',
    inputSchema: z.object({
      runId: nonEmptyString,
      agentId: nonEmptyString,
      maxLines: z.number().int().min(1).max(200).optional(),
      maxBytes: z.number().int().min(1).max(64 * 1024).optional()
    }).strict()
  }, (input) => requestTool(ipc, 'execution.agent_log', input));

  server.registerTool('agent_team_get_handoff', {
    description: 'Get the durable handoff for a completed execution run.',
    inputSchema: z.object({ runId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'execution.handoff', input));

  server.registerTool('agent_team_read_run_events', {
    description: 'Read durable run events after a controller cursor and acknowledge that cursor.',
    inputSchema: z.object({
      runId: nonEmptyString,
      clientId: nonEmptyString,
      afterEventId: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(1000).optional()
    }).strict()
  }, (input) => requestTool(ipc, 'execution.events', input));

  return server;
}

/** Connects the stdio MCP bridge to the local agent-team daemon. */
export async function runMcpServer(home: AgentTeamHome): Promise<void> {
  const ipc = new ReconnectingIpcRequester(home.socket);
  try {
    const server = createMcpServer(ipc);
    await server.connect(new StdioServerTransport());
  } catch (error) {
    ipc.close();
    throw error;
  }
}
