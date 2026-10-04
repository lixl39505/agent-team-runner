// Domain types for the ATeam delivery control plane (ADR 0001).

export const CONTRACT_VERSION = 1 as const;

export interface ProvenanceDocument {
  kind: string;
  reference: string;
}

export interface SkillRef {
  name: string;
  role?: SkillRole;
  required?: boolean;
  source?: string;
  sha256?: string;
}

export type SkillRole = 'worker' | 'reviewer' | 'integrator';

export interface TaskSpec {
  /** ^[A-Z][A-Z0-9_-]{1,31}$ — unique inside one contract. */
  id: string;
  externalId?: string;
  title: string;
  description?: string;
  /** Agent registry key (src/config.ts). Defaults to the run-level default. */
  agent?: string;
  dependsOn?: string[];
  /** Glob patterns. Allowed paths exclusively belong to one task per run. */
  allowedPaths: string[];
  blockedPaths?: string[];
  acceptance?: string[];
  /** Mechanical verification commands; each must pass the shell allowlist. */
  verificationCommands?: string[];
  implementationSkills?: SkillRef[];
  implementationGuidance?: string;
  allowNoChanges?: boolean;
}

export interface ExecutionContract {
  version: typeof CONTRACT_VERSION;
  project: {
    id: string;
    /** Absolute path of the repository this contract binds to. */
    repoRoot: string;
    baseRef: string;
  };
  provenance?: {
    documents?: ProvenanceDocument[];
  };
  tasks: TaskSpec[];
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  'queued',
  'planning',
  'planned',
  'running',
  'needs_attention',
  'integrating',
  'done',
  'cancelled',
  'abandoned',
  'failed',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TASK_STATUSES = [
  'pending',
  'running',
  'verifying',
  'reviewing',
  'changes_requested',
  'approved',
  'integrated',
  'blocked',
  'blocked_on_contract',
  'failed',
  'reclaimed',
  'discarded',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Persisted "next dispatch" intent (review 02 R2-02). Consuming a role
 * result and starting the follow-up (worker retry / review cycle) are two
 * steps; a crash between them must not strand the task. The intent is
 * written BEFORE the execution is consumed and cleared once the dispatch
 * is on the ledger, so recovery replays it from the task row alone.
 */
export type PendingDispatch = 'review' | 'worker_retry';

export const EXECUTION_STATUSES = [
  'starting',
  'running',
  'blocked',
  'result_pending',
  'completed',
  'failed',
  'abandoned',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export type ExecutionRole = 'worker' | 'reviewer' | 'integrator';

export type AgentKind = 'claude' | 'codex' | 'opencode';

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'opencode'];

/** Herdr semantic agent states (live observation only — never a credential). */
export type HerdrAgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

// ---------------------------------------------------------------------------
// Persisted records
// ---------------------------------------------------------------------------

export interface RunRecord {
  id: string;
  projectId: string;
  repoRoot: string;
  baseRef: string;
  baseSha: string;
  contractRevision: number;
  status: RunStatus;
  revisionPending: boolean;
  error: string | null;
  // Runner state machine, persisted so a fresh Runner process (or
  // `reconcile`) resumes integration/final verification instead of hanging
  // or rebuilding resources from scratch (review 01 #3).
  integrationWorkspaceId: string | null;
  integrationPath: string | null;
  integrationBranch: string | null;
  integrationRootPaneId: string | null;
  integrationBaseSha: string | null;
  /** Task currently blocked on an unresolved cherry-pick conflict. */
  conflictTaskId: string | null;
  /** Integrator gave up: needs human/reconcile intervention. */
  integrationStalled: boolean;
  /** Final mechanical verification passed; remaining work is reclamation. */
  finalVerified: boolean;
  finalVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface TaskRecord {
  runId: string;
  taskId: string;
  spec: TaskSpec;
  status: TaskStatus;
  attempts: number;
  reviewCycles: number;
  branch: string | null;
  worktreePath: string | null;
  workspaceId: string | null;
  startSha: string | null;
  commitSha: string | null;
  integrationCommit: string | null;
  lastError: string | null;
  contractBlock: unknown | null;
  review: unknown | null;
  /** Pending follow-up dispatch (R2-02): set before the follow-up starts,
   * cleared once the execution is on the ledger. */
  pendingDispatch: PendingDispatch | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ExecutionRecord {
  id: string;
  runId: string;
  taskId: string;
  role: ExecutionRole;
  attemptNo: number;
  cycleNo: number;
  agentName: string;
  agentKind: AgentKind;
  model: string | null;
  status: ExecutionStatus;
  /** Non-null forbids every recovery path from re-sending the prompt. */
  promptSentAt: string | null;
  promptDigest: string | null;
  resultPath: string | null;
  resultDigest: string | null;
  /** Digest of the result that has been APPLIED to the task state machine.
   * Distinct from resultDigest: a crash between receipt and application
   * replays from here instead of dropping the result (review 01 #1). */
  resultAppliedDigest: string | null;
  result: unknown | null;
  resultReceivedAt: string | null;
  nativeSessionRef: string | null;
  paneId: string | null;
  tabId: string | null;
  workspaceId: string | null;
  paneState: 'open' | 'closed_success' | 'retained' | 'gone';
  lastAgentState: HerdrAgentState | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type HerdrResourceKind = 'workspace' | 'tab' | 'pane' | 'worktree';

export type HerdrResourceState = 'active' | 'reclaimed' | 'orphaned' | 'lost';

export interface HerdrResourceRecord {
  id: number;
  runId: string;
  taskId: string | null;
  executionId: string | null;
  kind: HerdrResourceKind;
  herdrId: string;
  branch: string | null;
  path: string | null;
  provenance: boolean;
  state: HerdrResourceState;
  createdAt: string;
  reclaimedAt: string | null;
}

export type CleanupStep =
  | 'close_pane'
  | 'remove_worktree'
  | 'verify_branch_free'
  | 'delete_branch'
  | 'finalize';

export const CLEANUP_STEPS: readonly CleanupStep[] = [
  'close_pane',
  'remove_worktree',
  'verify_branch_free',
  'delete_branch',
  'finalize',
];

export type EventType =
  | 'RUN_CREATED'
  | 'RUN_STATUS_CHANGED'
  | 'CONTRACT_REVISED'
  | 'TASK_STATUS_CHANGED'
  | 'EXECUTION_CREATED'
  | 'EXECUTION_PROMPTED'
  | 'RESULT_ACCEPTED'
  | 'VERIFICATION_PASSED'
  | 'VERIFICATION_FAILED'
  | 'TASK_APPROVED'
  | 'INTEGRATION_COMMITTED'
  | 'CLEANUP_STEP_OK'
  | 'CLEANUP_STEP_FAILED'
  | 'RECONCILE_DECISION'
  | 'RUN_INTERRUPTED'
  | 'RUN_FINISHED';
