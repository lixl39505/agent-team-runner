import type { AgentInvocation, AgentRunResult } from '../core/types.js';

export interface AgentAdapter {
  run<T>(input: AgentInvocation): Promise<AgentRunResult<T>>;
}
