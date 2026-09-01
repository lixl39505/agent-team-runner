export type BackendId = 'claude' | 'codex' | 'opencode';
/** @deprecated 旧名，随旧 adapter 层在 Phase 4 一起删除 */
export type AdapterName = BackendId;
export type AgentRole = 'worker' | 'reviewer' | 'integrator';
export type NativeWindowsSandboxPolicy = 'require' | 'allow-degraded';
export type AuthIsolation = 'shared' | 'isolated';

export type RunStatus =
  | 'planning'
  | 'planned'
  | 'running'
  | 'needs_attention'
  | 'integrating'
  | 'done'
  | 'cancelled'
  | 'failed';

export type RunRuntimeState = 'active' | 'waiting_interaction' | 'paused' | 'cancelling' | 'recovering';
export type RunDesiredState = 'running' | 'paused' | 'cancel_requested';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'changes_requested'
  | 'approved'
  | 'blocked'
  | 'blocked_on_contract'
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
  /** Keychain profile name; secrets are never stored in project configuration. */
  authProfile?: string;
  authIsolation?: AuthIsolation;
  baseUrl?: string;
}

/** 角色或任务解析出的 agent 绑定（取代旧 ResolvedProfile） */
export interface AgentBinding {
  /** 注册表名，或内联 "backend.model" 规格原文 */
  agent: string;
  backend: BackendId;
  model?: string;
  /** turn 上限（来自 agents 注册表条目） */
  maxTurns?: number;
  authProfile?: string;
  authIsolation?: AuthIsolation;
  baseUrl?: string;
  /** 来源描述：roles.<role> / defaultAgent / task:<name> / snapshot */
  source: string;
}

/** 创建运行时固化的全量快照（roles + agents 注册表），保证执行不受配置后续变化影响。 */
export interface AgentSnapshot {
  version: 2;
  roles: Record<AgentRole, AgentBinding>;
  agents: Record<string, AgentEntry>;
}

export interface RunnerConfig {
  version: 3;
  /** 缺省 agent（agents 注册表名），未配置的角色回退到它 */
  defaultAgent: string;
  concurrency: number;
  staleAfterMs: number;
  taskTimeoutMs: number;
  workspace: {
    repoRoot: string;
    stateDir: string;
    worktreesDir: string;
    baseRef: string;
    branchPrefix: string;
  };
  retry: {
    maxWorkerAttempts: number;
    maxReviewCycles: number;
  };
  status: {
    pollIntervalMs: number;
  };
  interactionAlert: {
    background: string;
    foreground: string;
  };
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
  };
}

export interface TaskSpec {
  id: string;
  /** 外层 SDD 的不透明任务标识，仅用于交接与追溯。 */
  externalId?: string;
  title: string;
  description: string;
  role?: string;
  /** agents 注册表名；缺省继承 worker 角色。 */
  agent?: string;
  dependsOn: string[];
  allowedPaths: string[];
  blockedPaths: string[];
  acceptance: string[];
  verificationCommands: string[];
  /** 外层选择的本地 Skill；Runner 在提交 run 时解析并固化内容。 */
  implementationSkills?: SkillRequirement[];
  /** 不依赖 Skill 的实施方法约束，例如测试先行。 */
  implementationGuidance?: string[];
  allowNoChanges?: boolean;
}

export interface SkillRequirement {
  name: string;
  role: 'worker' | 'reviewer' | 'integrator';
  required: boolean;
  source: 'project' | 'user';
}

export interface ResolvedSkill {
  name: string;
  role: SkillRequirement['role'];
  source: SkillRequirement['source'];
  path: string;
  sha256: string;
  content: string;
}

/** 可供外层选择的本地 project Skill 元数据；内容仅在提交 run 时固化。 */
export interface ProjectSkill {
  name: string;
  source: 'project';
  path: string;
  sha256: string;
}

export interface ExecutionProvenanceDocument {
  kind: string;
  locator: string;
  revision: string;
}

/** 外层 SDD 交给执行层的完整、可验证 DAG。 */
export interface ExecutionContract {
  version: 1;
  project: {
    id: string;
    repoRoot: string;
    baseRef: string;
  };
  target: {
    integrationBranch?: string;
  };
  provenance?: {
    documents: ExecutionProvenanceDocument[];
  };
  tasks: TaskSpec[];
}

/** A concrete Worker/Reviewer/Integrator invocation within a run. */
export interface AgentExecutionRecord {
  runId: string;
  agentId: string;
  taskId: string | null;
  role: AgentRole;
  backend: BackendId;
  model: string | null;
  status: 'running' | 'completed' | 'failed';
  sessionId: string | null;
  logPath: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface RunManifest {
  version: 1;
  title: string;
  summary: string;
  tasks: TaskSpec[];
}

export type ContractBlockCode =
  | 'out_of_scope'
  | 'missing_requirement'
  | 'conflicting_requirement'
  | 'dependency_change'
  | 'missing_access'
  | 'other';

/** Worker 请求修改执行契约时提供的结构化原因。 */
export interface ContractBlockReason {
  code: ContractBlockCode;
  message: string;
  requestedContractChanges: string[];
  affectedPaths?: string[];
}

interface WorkerResultBase {
  summary: string;
  testsRun: string[];
  knownRisks: string[];
  blockedReason?: string;
}

export type WorkerResult =
  | (WorkerResultBase & { status: 'completed' | 'blocked' | 'failed'; contractBlock?: never })
  | (WorkerResultBase & { status: 'blocked_on_contract'; contractBlock: ContractBlockReason });

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
  knownRisks: string[];
  blockedReason?: string;
}

export interface RunRecord {
  id: string;
  repoRoot: string;
  goalFile: string;
  baseRef: string;
  baseSha: string;
  /** 外层全局项目标识；历史本地 run 可能没有此引用。 */
  projectId: string | null;
  /** 提交执行时选定的项目策略修订标识。 */
  projectPolicyRevisionId: string | null;
  /** 提交时固化的完整 ExecutionContract。 */
  executionContractJson: string | null;
  /** 当前 ExecutionContract revision；历史本地 run 没有时视为 0。 */
  contractRevision: number;
  /** 运行来源后端（历史列名，保持 schema 不变）。 */
  adapter: string;
  status: RunStatus;
  runtimeState: RunRuntimeState;
  desiredState: RunDesiredState;
  manifestJson: string | null;
  /** 创建运行时固化的 AgentSnapshot，保证后续执行不受配置文件变化影响。 */
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
  /** 提交或契约修订时固化的 ResolvedSkill 数组。 */
  resolvedSkillsJson: string;
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

/** A durable event emitted while executing a run. */
export interface RunEventRecord {
  id: number;
  runId: string;
  taskId: string | null;
  eventType: string;
  payload: unknown | null;
  createdAt: string;
}

/** Hook payload for forwarding a worker contract escalation to an outer service. */
export interface ContractBlockReport {
  run: RunRecord;
  task: TaskRecord;
  agentExecution: AgentExecutionRecord;
  reason: ContractBlockReason;
}
