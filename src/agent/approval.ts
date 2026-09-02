import type { AgentRole, BackendId } from '../core/types.js';

export type ApprovalDecision = 'once' | 'session' | 'deny';

export interface ApprovalRequest {
  backend: BackendId;
  role: AgentRole;
  label?: string | undefined;
  sessionId?: string | undefined;
  taskId?: string | undefined;
  cwd: string;
  kind: 'command' | 'file-change' | 'network' | 'external-directory' | 'tool';
  tool: string;
  input: unknown;
  title?: string | undefined;
  description?: string | undefined;
  reason?: string | undefined;
  allowSession: boolean;
}

export type ApprovalHandler = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;

export interface UserInputOption {
  label: string;
  description?: string | undefined;
}

export interface UserInputQuestion {
  id: string;
  header?: string | undefined;
  question: string;
  options?: UserInputOption[] | undefined;
  multiple?: boolean | undefined;
  allowCustom?: boolean | undefined;
  secret?: boolean | undefined;
}

export interface UserInputRequest {
  backend: BackendId;
  role: AgentRole;
  label?: string | undefined;
  sessionId?: string | undefined;
  taskId?: string | undefined;
  cwd: string;
  questions: UserInputQuestion[];
}

export type UserInputAnswers = Record<string, string[]>;
export type UserInputHandler = (request: UserInputRequest, signal?: AbortSignal) => Promise<UserInputAnswers>;
