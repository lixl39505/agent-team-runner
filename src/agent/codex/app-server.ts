import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentBackend,
  AgentEvent,
  AgentRunOutcome,
  AgentSession,
  DiscoveryResult,
  ModelInfo,
  ProbeResult,
  SessionSpec
} from '../types.js';
import type { BackendId } from '../../core/types.js';
import { JsonRpcConnection } from './jsonrpc.js';
import { compileCodex, type CodexApprovalDecision, type CompiledCodexPolicy } from './policy.js';
import { sanitizedEnv } from '../env.js';
import { parseAgentJson } from '../parse.js';
// 窄类型导入（import type = 零运行时耦合）：只引入我们实际消费的协议类型，
// 上游破坏性变更在 `npm run check` 时直接变成编译错误——升级流程见 gen:codex。
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse.js';
import type { TurnStartParams } from './protocol/v2/TurnStartParams.js';
import type { Turn } from './protocol/v2/Turn.js';
import type { TurnCompletedNotification } from './protocol/v2/TurnCompletedNotification.js';
import type { ItemCompletedNotification } from './protocol/v2/ItemCompletedNotification.js';
import type { ThreadItem } from './protocol/v2/ThreadItem.js';
import type { ThreadTokenUsageUpdatedNotification } from './protocol/v2/ThreadTokenUsageUpdatedNotification.js';
import type { CommandExecutionRequestApprovalParams } from './protocol/v2/CommandExecutionRequestApprovalParams.js';
import type { CommandExecutionRequestApprovalResponse } from './protocol/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from './protocol/v2/FileChangeRequestApprovalResponse.js';
import type { ModelListResponse } from './protocol/v2/ModelListResponse.js';

const CLIENT_INFO = { name: 'agent-team-runner', title: null, version: '0.1.0' };

export interface CodexBackendOptions {
  command?: string | undefined;
}

interface TurnRecord {
  status: string;
  error: unknown;
  agentMessages: string[];
  tokenUsage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
}

/**
 * codex 后端：常驻一个 `codex app-server` 子进程（进程组），跨 turn/thread 复用。
 * 审批请求（item/commandExecution/requestApproval、item/fileChange/requestApproval）
 * 由 Runner policy 程序化应答——codex 的授权闭环。
 */
export class CodexBackend implements AgentBackend {
  readonly id: BackendId = 'codex';
  private connection: JsonRpcConnection | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, CodexAgentSession>();

  constructor(private readonly options: CodexBackendOptions = {}) {}

  private get command(): string {
    return this.options.command ?? 'codex';
  }

  async discover(): Promise<DiscoveryResult> {
    return await new Promise<DiscoveryResult>((resolve) => {
      let child;
      try {
        child = spawn(this.command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve({ backend: 'codex', installed: false, detail: `failed to spawn ${this.command}` });
        return;
      }
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ backend: 'codex', installed: false, detail: 'version probe timed out' });
      }, 10_000);
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ backend: 'codex', installed: false, detail: `failed to spawn ${this.command}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          backend: 'codex',
          installed: code === 0,
          version: stdout.trim() || undefined,
          ...(code === 0 ? {} : { detail: `exit ${code}` })
        });
      });
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.ensureServer();
    const response = await this.connection!.request('model/list', {}, 30_000) as ModelListResponse;
    const models: ModelInfo[] = [];
    for (const entry of response.data) {
      if (entry.hidden) continue;
      models.push({ id: entry.id, ...(entry.displayName ? { displayName: entry.displayName } : {}) });
      if (entry.model && entry.model !== entry.id) models.push({ id: entry.model, displayName: entry.displayName });
    }
    return models;
  }

  async probe(model?: string | undefined): Promise<ProbeResult> {
    const started = Date.now();
    const scratch = mkdtempSync(join(tmpdir(), 'agent-team-codex-probe-'));
    const session = await this.openSession({
      role: 'lead',
      cwd: scratch,
      prompt: 'Reply with exactly: ok',
      schema: { type: 'string' },
      policy: { fs: { mode: 'read-only' }, bash: { mode: 'deny' }, network: false },
      timeoutMs: 60_000,
      staleAfterMs: 60_000,
      ...(model !== undefined ? { model } : {})
    });
    try {
      const outcome = await session.completion();
      return {
        ok: outcome.ok,
        ...(outcome.ok ? {} : { error: outcome.error ?? 'probe failed' }),
        latencyMs: Date.now() - started
      };
    } finally {
      await session.close();
    }
  }

  async openSession(spec: SessionSpec): Promise<AgentSession> {
    await this.ensureServer();
    const compiled = compileCodex(spec.policy, spec.cwd);
    const params: ThreadStartParams = {
      cwd: spec.cwd,
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      approvalPolicy: compiled.approvalPolicy,
      sandbox: compiled.sandboxPolicy.type === 'readOnly' ? 'read-only' : 'workspace-write'
    };
    const response = await this.connection!.request('thread/start', params, 30_000) as ThreadStartResponse;
    const threadId = response.thread.id;
    const session = new CodexAgentSession(this.connection!, threadId, spec, compiled);
    this.sessions.set(threadId, session);
    spec.onEvent?.({ type: 'session', sessionId: threadId });
    return session;
  }

  /** 销毁共享 app-server（runner 退出时调用） */
  dispose(): void {
    this.sessions.clear();
    this.connection?.close();
    this.connection = null;
    this.initialized = false;
    this.initPromise = null;
  }

  handleNotification(method: string, params: unknown): void {
    if (method === 'turn/completed') {
      const record = params as TurnCompletedNotification;
      this.sessions.get(record.threadId)?.onTurnCompleted(record.turn);
      return;
    }
    if (method === 'item/completed') {
      const record = params as ItemCompletedNotification;
      this.sessions.get(record.threadId)?.onItemCompleted(record.item);
      return;
    }
    if (method === 'item/agentMessage/delta' || method === 'command/exec/outputDelta' || method === 'item/commandExecution/outputDelta' || method === 'item/reasoning/summaryTextDelta') {
      const threadId = (params as { threadId?: string }).threadId;
      if (threadId) this.sessions.get(threadId)?.onActivity();
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const record = params as ThreadTokenUsageUpdatedNotification;
      const total = record.tokenUsage.total;
      this.sessions.get(record.threadId)?.onUsage({
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens
      });
    }
  }

  handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval') {
      const record = params as CommandExecutionRequestApprovalParams;
      const session = this.sessions.get(record.threadId);
      const response: CommandExecutionRequestApprovalResponse = {
        decision: session
          ? session.approveCommand(String(record.command ?? ''))
          : 'decline'
      };
      return Promise.resolve(response);
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const threadId = (params as { threadId?: string }).threadId;
      const session = threadId ? this.sessions.get(threadId) : undefined;
      const response: FileChangeRequestApprovalResponse = {
        decision: session ? session.approveFileChange() : 'decline'
      };
      return Promise.resolve(response);
    }
    if (method === 'execCommandApproval') {
      // v1 遗留审批：载荷不带 threadId，保持宽松解析
      const record = params as { command?: string | Array<{ command?: string }> };
      const command = typeof record.command === 'string' ? record.command : record.command?.[0]?.command ?? '';
      const decision = this.approveGlobally(command);
      return Promise.resolve({ decision });
    }
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      return Promise.reject(new Error('no interactive user is available in headless team runs'));
    }
    return Promise.reject(new Error(`unhandled app-server request: ${method}`));
  }

  private approveGlobally(command: string): 'accept' | 'decline' {
    for (const session of this.sessions.values()) {
      return session.approveCommand(command) === 'decline' ? 'decline' : 'accept';
    }
    return 'decline';
  }

  private ensureServer(): Promise<void> {
    if (this.initialized && this.connection && !this.connection.exited) return Promise.resolve();
    this.initPromise ??= this.startServer();
    return this.initPromise;
  }

  private async startServer(): Promise<void> {
    this.connection = new JsonRpcConnection(
      this.command,
      ['app-server'],
      {
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (method, params) => this.handleServerRequest(method, params)
      },
      sanitizedEnv()
    );
    try {
      await this.connection.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null }, 30_000);
      this.initialized = true;
    } catch (error) {
      this.connection.close();
      this.connection = null;
      this.initPromise = null;
      throw error;
    }
  }
}

class CodexAgentSession implements AgentSession {
  readonly sessionId: string;
  private readonly state: TurnRecord = { status: '', error: null, agentMessages: [], tokenUsage: undefined };
  private interrupted = false;
  private readonly resultPromise: Promise<AgentRunOutcome>;
  private settled = false;

  constructor(
    private readonly connection: JsonRpcConnection,
    threadId: string,
    private readonly spec: SessionSpec,
    private readonly compiled: CompiledCodexPolicy
  ) {
    this.sessionId = threadId;
    this.resultPromise = new Promise((resolve) => { this.resolveResult = resolve; });
    void this.startTurn();
  }

  private resolveResult!: (outcome: AgentRunOutcome) => void;

  private async startTurn(): Promise<void> {
    const params: TurnStartParams = {
      threadId: this.sessionId,
      input: [{ type: 'text', text: this.spec.prompt, text_elements: [] }],
      cwd: this.spec.cwd,
      approvalPolicy: this.compiled.approvalPolicy,
      sandboxPolicy: this.compiled.sandboxPolicy,
      ...(this.spec.model !== undefined ? { model: this.spec.model } : {}),
      outputSchema: this.spec.schema
    };
    try {
      await this.connection.request('turn/start', params, this.spec.timeoutMs);
    } catch {
      // turn/start 的响应不是完成信号；turn/completed 通知才是。请求失败时由监督器兜底。
    }
  }

  approveCommand(command: string): 'accept' | 'acceptForSession' | 'decline' {
    const decision = this.compiled.decideCommand(command);
    this.spec.onEvent?.({
      type: 'permission-check',
      tool: 'Bash',
      input: { command },
      allowed: decision !== 'decline',
      ...(decision === 'decline' ? { reason: `command is not allowlisted for this role: ${command}` } : {})
    });
    return decision;
  }

  approveFileChange(): CodexApprovalDecision {
    const decision = this.compiled.decideFileChange();
    this.spec.onEvent?.({
      type: 'permission-check',
      tool: 'Edit',
      input: {},
      allowed: decision === 'accept',
      ...(decision === 'decline' ? { reason: 'file changes are denied for this role' } : {})
    });
    return decision;
  }

  onActivity(): void {
    this.spec.onEvent?.({ type: 'activity' });
  }

  onUsage(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }): void {
    this.state.tokenUsage = usage;
    this.spec.onEvent?.({
      type: 'usage',
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {})
    });
  }

  onItemCompleted(item: ThreadItem): void {
    if (item.type === 'agentMessage') {
      this.state.agentMessages.push(item.text);
      this.spec.onEvent?.({ type: 'message', text: item.text });
      return;
    }
    if (item.type === 'commandExecution') {
      const ok = item.exitCode === null || item.exitCode === 0;
      this.spec.onEvent?.({
        type: 'tool-result',
        tool: 'Bash',
        ok,
        ...(item.aggregatedOutput !== null ? { summary: item.aggregatedOutput.slice(0, 200) } : {})
      });
    }
  }

  onTurnCompleted(turn: Turn): void {
    if (this.settled) return;
    this.settled = true;
    this.state.status = turn.status;
    this.state.error = turn.error ?? null;
    const usage = this.state.tokenUsage;
    const text = this.state.agentMessages.at(-1);
    if (this.state.status === 'completed' && text !== undefined) {
      try {
        this.resolveResult({
          ok: true,
          output: parseAgentJson(text),
          timedOut: false,
          stalled: false,
          sessionId: this.sessionId,
          ...(usage ? { usage } : {})
        });
      } catch (error) {
        this.resolveResult({
          ok: false,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          timedOut: false,
          stalled: false,
          sessionId: this.sessionId
        });
      }
    } else {
      this.resolveResult({
        ok: false,
        output: null,
        error: `codex turn ${this.state.status || 'failed'}${this.state.error ? `: ${JSON.stringify(this.state.error).slice(0, 300)}` : ''}`,
        timedOut: this.interrupted,
        stalled: false,
        sessionId: this.sessionId,
        ...(usage ? { usage } : {})
      });
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    try {
      await this.connection.request('turn/interrupt', { threadId: this.sessionId }, 10_000);
    } catch { /* server may have exited */ }
  }

  async close(): Promise<void> {
    if (!this.settled) {
      this.settled = true;
      this.resolveResult({
        ok: false,
        output: null,
        error: 'session closed before the turn completed',
        timedOut: this.interrupted,
        stalled: false,
        sessionId: this.sessionId
      });
    }
  }

  completion(): Promise<AgentRunOutcome> {
    return this.resultPromise;
  }
}
