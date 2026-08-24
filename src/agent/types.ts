import type { AgentRole, BackendId, PolicySpec } from '../core/types.js';

export type { BackendId };

export interface ModelInfo {
  id: string;
  displayName?: string | undefined;
}

export interface DiscoveryResult {
  backend: BackendId;
  installed: boolean;
  version?: string | undefined;
  authed?: boolean | undefined;
  detail?: string | undefined;
}

export interface ProbeResult {
  ok: boolean;
  error?: string | undefined;
  latencyMs: number;
}

/** 后端事件流：真实心跳/进度/权限/用量信号（取代 stdout 静默判断） */
export type AgentEvent =
  | { type: 'activity' }
  | { type: 'session'; sessionId: string }
  | { type: 'message'; text: string }
  | { type: 'tool-call'; tool: string; input: unknown }
  | { type: 'tool-result'; tool: string; ok: boolean; summary?: string }
  | { type: 'permission-check'; tool: string; input: unknown; allowed: boolean; reason?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number };

export interface SessionSpec {
  role: AgentRole;
  cwd: string;
  prompt: string;
  /** 结构化输出 JSON Schema（后端原生通道：outputFormat/outputSchema/format） */
  schema: object;
  model?: string | undefined;
  /** 角色/任务权限规格，编译为各后端的权限控制 */
  policy: PolicySpec;
  timeoutMs: number;
  /** 静默超时：任何 AgentEvent 重置计时（"无进展"而非"无 stdout"） */
  staleAfterMs: number;
  maxTurns?: number | undefined;
  /** resume 上一个会话（实验开关 worker.resume 预留） */
  resumeSessionId?: string | undefined;
  onEvent?: ((event: AgentEvent) => void) | undefined;
  /** 仅对自 spawn 会话子进程的传输有意义（如旧 CLI transport） */
  onPid?: ((pid: number) => void) | undefined;
}

export interface AgentRunOutcome<T = unknown> {
  ok: boolean;
  output: T | null;
  error?: string | undefined;
  timedOut: boolean;
  stalled: boolean;
  sessionId?: string | undefined;
  usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
}

export interface AgentSession {
  readonly sessionId?: string | undefined;
  interrupt(): Promise<void>;
  /** 终止传输；必须可重入 */
  close(): Promise<void>;
  /** turn 结束时 resolve；传输层故障 reject */
  completion(): Promise<AgentRunOutcome>;
}

export interface AgentBackend {
  readonly id: BackendId;
  /** CLI 安装/版本/认证状态 */
  discover(): Promise<DiscoveryResult>;
  /** 枚举本地可用 model（claude supportedModels / codex model/list / opencode /config/providers） */
  listModels(): Promise<ModelInfo[]>;
  /** 1-token 真实试跑 = 权威可用性验证 */
  probe(model?: string | undefined): Promise<ProbeResult>;
  openSession(spec: SessionSpec): Promise<AgentSession>;
}
