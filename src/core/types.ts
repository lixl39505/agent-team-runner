export type AdapterName = 'claude' | 'codex' | 'opencode';
export type AgentRole = 'lead' | 'worker' | 'reviewer' | 'integrator';

export type RunStatus =
  | 'planning'
  | 'planned'
  | 'running'
  | 'needs_attention'
  | 'integrating'
  | 'done'
  | 'failed'
  | 'stopped';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'changes_requested'
  | 'approved'
  | 'blocked'
  | 'failed';

export interface AdapterConfig {
  command: string;
  extraArgs?: string[];
  model?: string;
}

/** Agent profile 字符串 "cli.model" 解析结果，如 "codex.terra" → { cli: 'codex', model: 'gpt-5.6-terra' } */
export interface ResolvedProfile {
  cli: AdapterName;
  model?: string | undefined;
  /** 原始 profile 字符串或回退来源描述 */
  source: string;
}

export interface RunnerConfig {
  version: 1;
  repoRoot: string;
  stateDir: string;
  worktreesDir: string;
  baseRef: string;
  defaultAdapter: AdapterName;
  concurrency: number;
  pollIntervalMs: number;
  staleAfterMs: number;
  taskTimeoutMs: number;
  maxPlanAttempts: number;
  maxWorkerAttempts: number;
  maxReviewCycles: number;
  branchPrefix: string;
  /** model 别名表：短名 → 真实 model id（如 terra → gpt-5.6-terra） */
  models?: Record<string, string>;
  /** 角色 → Agent profile（"cli.model" 字符串），缺省回退 defaultAdapter */
  roles?: Partial<Record<AgentRole, string>>;
  verification: {
    allowedCommandPrefixes: string[];
    globalCommands: string[];
  };
  integration: {
    allowedPaths: string[];
    runAgentAfterCherryPick: boolean;
  };
  adapters: Record<AdapterName, AdapterConfig>;
}

export interface TaskSpec {
  id: string;
  title: string;
  description: string;
  role?: string;
  adapter?: AdapterName;
  dependsOn: string[];
  allowedPaths: string[];
  blockedPaths: string[];
  acceptance: string[];
  verificationCommands: string[];
  allowNoChanges?: boolean;
}

export interface RunManifest {
  version: 1;
  title: string;
  summary: string;
  tasks: TaskSpec[];
}

export interface LeadResult extends RunManifest {}

export interface WorkerResult {
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
  testsRun: string[];
  knownRisks: string[];
  architectureImpact: string;
  progressImpact: string;
  blockedReason?: string;
}

export interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  message: string;
}

export interface ReviewResult {
  decision: 'approved' | 'changes_requested';
  summary: string;
  findings: ReviewFinding[];
  requiredChanges: string[];
}

export interface IntegrationResult {
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
  testsRun: string[];
  documentationUpdated: string[];
  knownRisks: string[];
  blockedReason?: string;
}

export interface RunRecord {
  id: string;
  repoRoot: string;
  goalFile: string;
  baseRef: string;
  baseSha: string;
  adapter: AdapterName;
  status: RunStatus;
  manifestJson: string | null;
  /** plan 时固化的角色 → profile 快照，保证后续 run 不受配置文件变化影响 */
  rolesJson: string | null;
  integrationBranch: string | null;
  integrationWorktree: string | null;
  integrationCommit: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface TaskRecord {
  runId: string;
  taskId: string;
  title: string;
  specJson: string;
  status: TaskStatus;
  phase: string | null;
  branch: string | null;
  worktree: string | null;
  startSha: string | null;
  commitSha: string | null;
  attempts: number;
  reviewCycles: number;
  pid: number | null;
  lastError: string | null;
  reviewJson: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AgentInvocation {
  role: AgentRole;
  cwd: string;
  prompt: string;
  schema: object;
  logPath: string;
  outputPath: string;
  timeoutMs: number;
  staleAfterMs: number;
  onPid?: (pid: number) => void;
  onHeartbeat?: () => void;
}

export interface AgentRunResult<T = unknown> {
  exitCode: number;
  output: T | null;
  rawOutput: string;
  timedOut: boolean;
  stalled: boolean;
}
