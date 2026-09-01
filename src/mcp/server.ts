import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AgentTeamHome } from '../core/home.js';
import { LocalIpcClient } from '../daemon/ipc.js';

type IpcRequester = Pick<LocalIpcClient, 'request'>;

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

/** Creates the MCP control-plane bridge for an already connected daemon IPC client. */
export function createMcpServer(ipc: IpcRequester): McpServer {
  const server = new McpServer({ name: 'agent-team', version: '0.1.0' });

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
  }, (input) => requestTool(ipc, 'controller.attach', input));

  server.registerTool('agent_team_disconnect_controller', {
    description: 'Disconnect a controller client from a run.',
    inputSchema: z.object({ runId: nonEmptyString, clientId: nonEmptyString }).strict()
  }, (input) => requestTool(ipc, 'controller.disconnect', input));

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
  const ipc = new LocalIpcClient(home.socket);
  try {
    await ipc.connect();
    const server = createMcpServer(ipc);
    await server.connect(new StdioServerTransport());
  } catch (error) {
    ipc.close();
    throw error;
  }
}
