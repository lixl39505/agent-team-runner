import type { AgentBackend, AgentEvent, AgentRunOutcome, SessionSpec } from '../agent/types.js';
import { runAgent, type RunAgentInput } from '../agent/supervise.js';
import type { AgentRole, BackendId } from './types.js';
import { StateDatabase } from './db.js';

export interface AgentExecutionInfo {
  runId: string;
  agentId: string;
  taskId?: string | undefined;
  role: AgentRole;
  backend: BackendId;
  model?: string | undefined;
  logPath: string;
}

export type AgentEventSink = (info: AgentExecutionInfo, event: AgentEvent) => void;

export interface RunTrackedAgentInput<T> extends RunAgentInput {
  db: StateDatabase;
  execution: AgentExecutionInfo;
  onAgentEvent?: AgentEventSink | undefined;
}

/** Runs an agent while maintaining the durable execution index used by the TUI and logs command. */
export async function runTrackedAgent<T = unknown>(input: RunTrackedAgentInput<T>): Promise<AgentRunOutcome<T>> {
  const { db, execution, spec, onAgentEvent, ...runInput } = input;
  const executionDb = db as StateDatabase & {
    startAgentExecution?: (value: AgentExecutionInfo) => void;
    updateAgentExecution?: (runId: string, agentId: string, patch: { sessionId?: string; status?: 'running' | 'completed' | 'failed'; finishedAt?: string }) => void;
  };
  executionDb.startAgentExecution?.(execution);
  const trackedSpec: SessionSpec = {
    ...spec,
    onEvent: (event) => {
      if (event.type === 'session') executionDb.updateAgentExecution?.(execution.runId, execution.agentId, { sessionId: event.sessionId });
      spec.onEvent?.(event);
      onAgentEvent?.(execution, event);
    }
  };
  onAgentEvent?.(execution, { type: 'activity' });
  const outcome = await runAgent<T>({ ...runInput, spec: trackedSpec });
  executionDb.updateAgentExecution?.(execution.runId, execution.agentId, {
    status: outcome.ok ? 'completed' : 'failed',
    finishedAt: new Date().toISOString()
  });
  return outcome;
}

export function executionInfo(
  runId: string,
  agentId: string,
  role: AgentRole,
  backend: AgentBackend['id'],
  logPath: string,
  model?: string,
  taskId?: string
): AgentExecutionInfo {
  return { runId, agentId, role, backend, logPath, ...(model !== undefined ? { model } : {}), ...(taskId !== undefined ? { taskId } : {}) };
}
