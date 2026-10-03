// Herdr runtime domain types. Every id below is captured from a Herdr
// response — ATeam never predicts resource ids.

import type { AgentKind, HerdrAgentState } from '../core/types.ts';

export interface HerdrWorkspace {
  workspaceId: string;
  label?: string;
  cwd?: string;
  worktree?: { branch: string; path: string };
}

export interface HerdrTab {
  tabId: string;
  workspaceId: string;
  label?: string;
}

export interface HerdrPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
}

export interface HerdrWorktree {
  workspaceId: string;
  branch: string;
  path: string;
}

/** One task isolation unit: 1 worktree = 1 workspace = 1 tab = 1 root pane. */
export interface WorkspaceHandle {
  workspace: HerdrWorkspace;
  tab: HerdrTab;
  rootPane: HerdrPane;
  worktree: HerdrWorktree;
}

export interface PaneHandle {
  paneId: string;
  workspaceId: string;
  tabId: string;
}

export interface AgentRecord {
  name: string | null;
  paneId: string;
  state: HerdrAgentState;
  kind?: AgentKind | string;
  model?: string | null;
  nativeSessionRef?: string | null;
}

export interface AgentWaitResult {
  paneId: string;
  state: HerdrAgentState;
}

export interface HerdrProbe {
  version: string;
  protocolOk: boolean;
  transport: 'cli' | 'socket';
  capabilities: {
    worktree: boolean;
    agent: boolean;
    sessionSnapshot: boolean;
    reportAgent: boolean;
    plugin: boolean;
  };
}

export interface HerdrSessionSnapshot {
  version?: string;
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
  agents: AgentRecord[];
}

export type HerdrEventType =
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.closed'
  | 'tab.created'
  | 'tab.closed'
  | 'pane.created'
  | 'pane.updated'
  | 'pane.closed'
  | 'pane.exited'
  | 'pane.agent_status_changed'
  | 'worktree.created'
  | 'worktree.opened'
  | 'worktree.removed'
  | string;

export interface HerdrEvent {
  type: HerdrEventType;
  paneId?: string;
  workspaceId?: string;
  payload?: unknown;
}

export interface HerdrEventStream extends AsyncIterable<HerdrEvent> {
  close(): void;
}

export type HerdrErrorCode =
  | 'herdr_not_found'
  | 'herdr_not_running'
  | 'timeout'
  | 'not_found'
  | 'invalid_response'
  | 'unsupported_transport'
  | 'agent_not_found'
  | 'herdr_error';

export class HerdrError extends Error {
  constructor(
    readonly code: HerdrErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'HerdrError';
  }
}
