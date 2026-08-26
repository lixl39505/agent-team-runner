export type BackendId = 'claude' | 'codex' | 'opencode';
/** @deprecated 旧名，随旧 adapter 层在 Phase 4 一起删除 */
export type AdapterName = BackendId;
export type AgentRole = 'lead' | 'worker' | 'reviewer' | 'integrator';
export type NativeWindowsSandboxPolicy = 'require' | 'allow-degraded';

export type RunStatus =
  | 'planning'
  | 'planned'
  | 'running'
  | 'needs_attention'
  | 'integrating'
  | 'done'
  | 'failed';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'changes_requested'
  | 'approved'
  | 'blocked'
  | 'failed';

/** 后端传输层接线：如何找到/启动对应的 Code Agent 运行时 */
export interface BackendConfig {
  /** CLI 二进制名或路径，缺省用 backend id 本身 */
  command?: string;
  extraArgs?: string[];
  /** Native Windows only: fail closed unless degraded unsandboxed execution is explicitly allowed. */
  nativeWindowsSandbox?: NativeWindowsSandboxPolicy;
}

/** agents 注册表条目：一个具名的 agent = 后端 + model + 选项 */
export interface AgentEntry {
  backend: BackendId;
  model?: string;
  description?: string;
  maxTurns?: number;
}

/** 角色或任务解析出的 agent 绑定（取代旧 ResolvedProfile） */
export interface AgentBinding {
  /** 注册表名，或内联 "backend.model" 规格原文 */
  agent: string;
  backend: BackendId;
  model?: string;
  /** turn 上限（来自 agents 注册表条目） */
  maxTurns?: number;
  /** 来源描述：roles.<role> / defaultAgent / task:<name> / snapshot */
  source: string;
}

/** plan 时固化的全量快照（roles + agents 注册表），保证 run 不受配置文件后续变化影响 */
export interface AgentSnapshot {
  version: 2;
  roles: Record<AgentRole, AgentBinding>;
  agents: Record<string, AgentEntry>;
}

export interface RunnerConfig {
  version: 2;
  repoRoot: string;
  stateDir: string;
  worktreesDir: string;
  baseRef: string;
  /** 缺省 agent（agents 注册表名），未配置的角色回退到它 */
  defaultAgent: string;
  concurrency: number;
  pollIntervalMs: number;
  staleAfterMs: number;
  taskTimeoutMs: number;
  maxPlanAttempts: number;
  maxWorkerAttempts: number;
  maxReviewCycles: number;
  branchPrefix: string;
  backends: Record<BackendId, BackendConfig>;
  /** agent 注册表：名 → {backend, model, ...} */
  agents: Record<string, AgentEntry>;
  /** 角色 → agent 名（或内联 "backend.model" 规格），缺省回退 defaultAgent */
  roles: Partial<Record<AgentRole, string>>;
  verification: {
    allowedCommandPrefixes: string[];
    globalCommands: string[];
  };
  integration: {
    allowedPaths: string[];
    runAgentAfterCherryPick: boolean;
  };
}

export interface TaskSpec {
  id: string;
  title: string;
  description: string;
  role?: string;
  /** agents 注册表名：Lead 为任务点名更合适的 agent；缺省继承 worker 角色 */
  agent?: string;
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
  /** plan 时 Lead 使用的后端（历史列名，保持 schema 不变） */
  adapter: string;
  status: RunStatus;
  manifestJson: string | null;
  /** plan 时固化的 AgentSnapshot（roles + agents 注册表），保证后续 run 不受配置文件变化影响 */
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
  lastError: string | null;
  reviewJson: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}
