// The narrow runtime seam between ATeam and Herdr (ADR 0001):
// everything terminal/pane/agent/worktree goes through this interface so
// the runner stays testable against fakes and portable across platforms.

import type {
  AgentRecord,
  AgentWaitResult,
  HerdrEventStream,
  HerdrProbe,
  HerdrSessionSnapshot,
  PaneHandle,
  WorkspaceHandle,
} from './types.ts';
import type { AgentKind, HerdrAgentState } from '../core/types.ts';

export interface CreateWorktreeInput {
  /** Source workspace whose repo the new worktree branches from. */
  sourceWorkspaceId: string;
  branch: string;
  label?: string;
  focus?: boolean;
}

export interface OpenWorktreeInput {
  sourceWorkspaceId: string;
  branch?: string;
  path?: string;
}

export interface StartAgentInput {
  name: string;
  kind: AgentKind;
  paneId: string;
  args: string[];
  readyTimeoutMs?: number;
  env?: Record<string, string>;
}

export interface PromptAgentInput {
  target: string;
  text: string;
  wait: boolean;
  until: Array<'idle' | 'done' | 'blocked'>;
  timeoutMs: number;
  /**
   * Idempotency key for THIS prompt (review 02 R2-10): the runtime MUST
   * dedupe repeated sends under one requestId, so a crash-recovery resend
   * after an uncertain delivery never double-injects. The runner always
   * passes the execution's persisted prompt digest. Transports without
   * request-id support must refuse deliveries whose recovery would depend
   * on it, not silently resend.
   */
  requestId?: string;
}

export interface ReadPaneInput {
  paneId: string;
  source?: 'recent' | 'recent-unwrapped' | 'visible' | 'detection';
  lines?: number;
}

export interface HerdrRuntimeClient {
  /** Fail-fast probe: version + protocol + capability matrix. */
  probe(): Promise<HerdrProbe>;

  createWorktreeWorkspace(input: CreateWorktreeInput): Promise<WorkspaceHandle>;
  openWorktree(input: OpenWorktreeInput): Promise<WorkspaceHandle>;
  removeWorktree(input: { workspaceId: string; force?: boolean }): Promise<void>;

  splitPane(input: { paneId: string; direction?: 'right' | 'down'; label?: string }): Promise<PaneHandle>;
  closePane(paneId: string): Promise<void>;
  focusPane(paneId: string): Promise<void>;

  startAgent(input: StartAgentInput): Promise<AgentRecord>;
  promptAgent(input: PromptAgentInput): Promise<AgentWaitResult>;
  waitAgent(input: { target: string; until: Array<'done' | 'blocked'>; timeoutMs?: number }): Promise<AgentWaitResult>;
  getAgent(target: string): Promise<AgentRecord | null>;
  readPane(input: ReadPaneInput): Promise<string>;

  /** Runner pane self-report (working/blocked/done/idle). */
  reportAgentState(input: {
    paneId: string;
    agent: string;
    state: HerdrAgentState;
    message?: string;
  }): Promise<void>;

  snapshot(): Promise<HerdrSessionSnapshot>;
  /** Long-lived event stream; CLI-only transports throw unsupported_transport. */
  subscribe(filter?: { paneId?: string }): Promise<HerdrEventStream>;
}
