import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AgentTeamHome } from '../core/home.js';
import { LocalIpcClient } from '../daemon/ipc.js';

type IpcRequester = Pick<LocalIpcClient, 'request'>;

const emptyInput = z.object({}).strict();
const nonEmptyString = z.string().min(1);

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
    description: 'List queued, claimed, and resolved interactions, optionally for one run.',
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
      response: z.json()
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

  server.registerTool('agent_team_list_reconnectable_runs', {
    description: 'List runs whose controllers can reconnect.',
    inputSchema: emptyInput
  }, () => requestTool(ipc, 'controller.reconnectable'));

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
