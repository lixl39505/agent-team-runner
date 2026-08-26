import spawn from 'cross-spawn';
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
import type { BackendId, NativeWindowsSandboxPolicy } from '../../core/types.js';
import { JsonRpcConnection } from './jsonrpc.js';
import { compileCodex, type CompiledCodexPolicy } from './policy.js';
import type { ApprovalDecision, ApprovalRequest } from '../approval.js';
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
import type { FileChangeRequestApprovalParams } from './protocol/v2/FileChangeRequestApprovalParams.js';
import type { FileChangeRequestApprovalResponse } from './protocol/v2/FileChangeRequestApprovalResponse.js';
import type { FileChangePatchUpdatedNotification } from './protocol/v2/FileChangePatchUpdatedNotification.js';
import type { ModelListResponse } from './protocol/v2/ModelListResponse.js';
import type { ApplyPatchApprovalParams } from './protocol/ApplyPatchApprovalParams.js';
import type { ExecCommandApprovalParams } from './protocol/ExecCommandApprovalParams.js';
import type { ReviewDecision } from './protocol/ReviewDecision.js';
import type { PermissionsRequestApprovalParams } from './protocol/v2/PermissionsRequestApprovalParams.js';
import type { PermissionsRequestApprovalResponse } from './protocol/v2/PermissionsRequestApprovalResponse.js';
import type { GrantedPermissionProfile } from './protocol/v2/GrantedPermissionProfile.js';
import type { ToolRequestUserInputParams } from './protocol/v2/ToolRequestUserInputParams.js';
import type { ToolRequestUserInputResponse } from './protocol/v2/ToolRequestUserInputResponse.js';
import type { McpServerElicitationRequestResponse } from './protocol/v2/McpServerElicitationRequestResponse.js';
import type { WindowsSandboxReadiness } from './protocol/v2/WindowsSandboxReadiness.js';
import type { WindowsSandboxReadinessResponse } from './protocol/v2/WindowsSandboxReadinessResponse.js';
import type { PlatformCheckResult } from '../types.js';

const CLIENT_INFO = { name: 'agent-team-runner', title: null, version: '0.1.0' };

export interface CodexBackendOptions {
  command?: string | undefined;
  nativeWindowsSandbox?: NativeWindowsSandboxPolicy | undefined;
  /** Test seam; production always uses process.platform. */
  platform?: NodeJS.Platform | undefined;
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
 * are forwarded to the foreground Runner CLI and answered with Codex-native decisions.
 */
export class CodexBackend implements AgentBackend {
  readonly id: BackendId = 'codex';
  private connection: JsonRpcConnection | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private platformCheckPromise: Promise<PlatformCheckResult> | null = null;
  private readonly sessions = new Map<string, CodexAgentSession>();
  private readonly platform: NodeJS.Platform;
  private readonly nativeWindowsSandbox: NativeWindowsSandboxPolicy;

  constructor(private readonly options: CodexBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.nativeWindowsSandbox = options.nativeWindowsSandbox ?? 'require';
  }

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

  async checkPlatform(): Promise<PlatformCheckResult> {
    if (this.platform !== 'win32') {
      return { ok: true, degraded: false, detail: 'native Windows policy is not applicable' };
    }
    this.platformCheckPromise ??= (async () => {
      try {
        await this.ensureServer();
        const response = await this.connection!.request('windowsSandbox/readiness', undefined, 30_000) as WindowsSandboxReadinessResponse;
        return codexWindowsSandboxCapability(response.status, this.nativeWindowsSandbox, this.platform);
      } catch (error) {
        return codexWindowsSandboxCapability(
          'unavailable', this.nativeWindowsSandbox, this.platform,
          error instanceof Error ? error.message : String(error)
        );
      }
    })();
    return await this.platformCheckPromise;
  }

  async probe(model?: string | undefined): Promise<ProbeResult> {
    const started = Date.now();
    const scratch = mkdtempSync(join(tmpdir(), 'agent-team-codex-probe-'));
    const session = await this.openSession({
      role: 'lead',
      cwd: scratch,
      prompt: 'Reply with exactly: ok',
      schema: { type: 'string' },
      access: 'read-only',
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
    const platform = await this.checkPlatform();
    if (!platform.ok) throw new Error(platform.detail);
    await this.ensureServer();
    const compiled = compileCodex(spec.access, spec.cwd);
    const params: ThreadStartParams = {
      cwd: spec.cwd,
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      approvalPolicy: compiled.approvalPolicy,
      sandbox: compiled.sandboxPolicy.type === 'readOnly' ? 'read-only' : 'workspace-write'
    };
    const response = await this.connection!.request('thread/start', params, 30_000) as ThreadStartResponse;
    const threadId = response.thread.id;
    const session = new CodexAgentSession(
      this.connection!, threadId, spec, compiled,
      () => this.sessions.delete(threadId)
    );
    this.sessions.set(threadId, session);
    spec.onEvent?.({ type: 'session', sessionId: threadId });
    return session;
  }

  /** 销毁共享 app-server（runner 退出时调用） */
  dispose(): void {
    for (const session of [...this.sessions.values()]) void session.close();
    this.sessions.clear();
    this.connection?.close();
    this.connection = null;
    this.initialized = false;
    this.initPromise = null;
    this.platformCheckPromise = null;
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
      return;
    }
    if (method === 'item/fileChange/patchUpdated') {
      const record = params as FileChangePatchUpdatedNotification;
      this.sessions.get(record.threadId)?.onFileChangePatch(record.itemId, record.changes.map((change) => change.path));
    }
  }

  async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval') {
      const record = params as CommandExecutionRequestApprovalParams;
      const session = this.sessions.get(record.threadId);
      const response: CommandExecutionRequestApprovalResponse = {
        decision: session
          ? await session.approveCommand(String(record.command ?? ''), record)
          : 'decline'
      };
      return response;
    }
    if (method === 'item/fileChange/requestApproval') {
      const record = params as Partial<FileChangeRequestApprovalParams>;
      const threadId = record.threadId;
      const session = threadId ? this.sessions.get(threadId) : undefined;
      const response: FileChangeRequestApprovalResponse = {
        decision: session && record.itemId ? await session.approveFileChange(record.itemId, record.grantRoot, record.reason) : 'decline'
      };
      return response;
    }
    if (method === 'item/permissions/requestApproval') {
      const record = params as PermissionsRequestApprovalParams;
      const session = this.sessions.get(record.threadId);
      if (!session) return deniedPermissionResponse();
      return await session.approvePermissions(record);
    }
    if (method === 'applyPatchApproval') {
      const record = params as ApplyPatchApprovalParams;
      const session = this.sessions.get(record.conversationId);
      const decision = session
        ? await session.approveFilePaths(Object.keys(record.fileChanges), record.grantRoot, record.reason)
        : 'decline';
      return { decision: legacyReviewDecision(decision) };
    }
    if (method === 'execCommandApproval') {
      const record = params as ExecCommandApprovalParams;
      const session = this.sessions.get(record.conversationId);
      const decision = session
        ? await session.approveCommand(record.command.join(' '), undefined, record.reason, record.command)
        : 'decline';
      return { decision: legacyReviewDecision(decision) };
    }
    if (method === 'item/tool/requestUserInput') {
      const record = params as ToolRequestUserInputParams;
      const session = this.sessions.get(record.threadId);
      return session ? await session.answerUserInput(record) : { answers: {} } satisfies ToolRequestUserInputResponse;
    }
    if (method === 'mcpServer/elicitation/request') {
      // MCP forms have a separate schema and security boundary. Decline until a typed form renderer is available.
      return { action: 'decline', content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
    }
    throw new Error(`unhandled app-server request: ${method}`);
  }

  private ensureServer(): Promise<void> {
    if (this.initialized && this.connection && !this.connection.exited) return Promise.resolve();
    this.initPromise ??= this.startServer();
    return this.initPromise;
  }

  private async startServer(): Promise<void> {
    const connection = new JsonRpcConnection(
      this.command,
      ['app-server'],
      {
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (method, params) => this.handleServerRequest(method, params),
        onExit: () => {
          if (this.connection !== connection) return;
          for (const session of [...this.sessions.values()]) void session.close();
          this.sessions.clear();
          this.connection = null;
          this.initialized = false;
          this.initPromise = null;
          this.platformCheckPromise = null;
        }
      },
      sanitizedEnv()
    );
    this.connection = connection;
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

export function codexWindowsSandboxCapability(
  status: WindowsSandboxReadiness | 'unavailable',
  policy: NativeWindowsSandboxPolicy,
  platform: NodeJS.Platform,
  error?: string
): PlatformCheckResult {
  if (platform !== 'win32') return { ok: true, degraded: false, detail: 'native Windows policy is not applicable' };
  if (status === 'ready') return { ok: true, degraded: false, detail: 'Codex native Windows sandbox is ready' };
  const reason = status === 'unavailable'
    ? `Codex Windows sandbox readiness check failed${error ? `: ${error}` : ''}`
    : `Codex native Windows sandbox is ${status}`;
  return policy === 'allow-degraded'
    ? { ok: true, degraded: true, detail: `${reason}; unsandboxed execution was explicitly allowed` }
    : { ok: false, degraded: false, detail: `${reason}; configure/update the Codex sandbox or explicitly set nativeWindowsSandbox: allow-degraded` };
}

class CodexAgentSession implements AgentSession {
  readonly sessionId: string;
  private readonly state: TurnRecord = { status: '', error: null, agentMessages: [], tokenUsage: undefined };
  private interrupted = false;
  private readonly resultPromise: Promise<AgentRunOutcome>;
  private settled = false;
  private readonly pendingFileChanges = new Map<string, string[]>();
  private readonly approvalController = new AbortController();

  get cwd(): string {
    return this.spec.cwd;
  }

  constructor(
    private readonly connection: JsonRpcConnection,
    threadId: string,
    private readonly spec: SessionSpec,
    private readonly compiled: CompiledCodexPolicy,
    private readonly onClose: () => void
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

  async approveCommand(
    command: string,
    request?: CommandExecutionRequestApprovalParams,
    legacyReason?: string | null,
    rawCommand?: unknown
  ): Promise<'accept' | 'acceptForSession' | 'decline'> {
    const decision = await this.ask({
      kind: request?.networkApprovalContext || (request?.proposedNetworkPolicyAmendments?.length ?? 0) > 0 ? 'network' : 'command',
      tool: 'Bash',
      input: {
        command: rawCommand ?? command,
        ...(request?.cwd ? { cwd: request.cwd } : {}),
        ...(request?.networkApprovalContext ? { network: request.networkApprovalContext } : {}),
        ...(request?.proposedNetworkPolicyAmendments ? { proposedNetworkPolicyAmendments: request.proposedNetworkPolicyAmendments } : {})
      },
      title: request?.networkApprovalContext
        ? `Codex wants network access to ${request.networkApprovalContext.host}`
        : `Codex wants to run: ${rawCommand ? JSON.stringify(rawCommand) : command}`,
      reason: request?.reason ?? legacyReason ?? undefined,
      allowSession: true
    });
    this.spec.onEvent?.({
      type: 'permission-check',
      tool: 'Bash',
      input: { command },
      allowed: decision !== 'deny',
      ...(decision === 'deny' ? { reason: 'denied by user' } : {})
    });
    return codexDecision(decision);
  }

  approveFileChange(itemId: string, grantRoot?: string | null, reason?: string | null): Promise<'accept' | 'acceptForSession' | 'decline'> {
    const paths = this.pendingFileChanges.get(itemId) ?? [];
    return this.approveFilePaths(paths, grantRoot, reason);
  }

  async approveFilePaths(paths: string[], grantRoot?: string | null, reason?: string | null): Promise<'accept' | 'acceptForSession' | 'decline'> {
    if (this.compiled.access === 'read-only') return 'decline';
    if (!grantRoot) {
      this.spec.onEvent?.({ type: 'permission-check', tool: 'Edit', input: { paths }, allowed: true });
      return 'accept';
    }
    const decision = await this.ask({
      kind: 'external-directory',
      tool: 'Edit',
      input: { paths, grantRoot },
      title: `Codex wants write access to ${grantRoot}`,
      reason: reason ?? undefined,
      allowSession: true
    });
    this.spec.onEvent?.({
      type: 'permission-check',
      tool: 'Edit',
      input: { paths },
      allowed: decision !== 'deny',
      ...(decision === 'deny' ? { reason: 'denied by user' } : {})
    });
    return codexDecision(decision);
  }

  async approvePermissions(request: PermissionsRequestApprovalParams): Promise<PermissionsRequestApprovalResponse> {
    const grantable = grantablePermissions(request.permissions, this.compiled.access);
    const decision = await this.ask({
      kind: request.permissions.network?.enabled ? 'network' : 'external-directory',
      tool: 'Permissions',
      input: request.permissions,
      title: 'Codex requests additional sandbox permissions',
      reason: request.reason ?? undefined,
      allowSession: true
    });
    this.spec.onEvent?.({
      type: 'permission-check',
      tool: 'Permissions',
      input: request.permissions,
      allowed: decision !== 'deny',
      ...(decision === 'deny' ? { reason: 'denied by user' } : {})
    });
    if (decision === 'deny') return deniedPermissionResponse();
    return { permissions: grantable, scope: decision === 'session' ? 'session' : 'turn' };
  }

  async answerUserInput(request: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
    if (!this.spec.requestUserInput) return { answers: {} };
    try {
      const questions = request.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        ...(question.options ? { options: question.options } : {}),
        allowCustom: question.isOther || question.options === null,
        secret: question.isSecret
      }));
      const answers = await this.spec.requestUserInput({
        backend: 'codex', role: this.spec.role, label: this.spec.label,
        sessionId: this.sessionId, cwd: this.spec.cwd, questions
      }, this.approvalController.signal);
      this.spec.onEvent?.({ type: 'activity' });
      return {
        answers: Object.fromEntries(request.questions.map((question) => [
          question.id,
          { answers: answers[question.id] ?? [] }
        ]))
      };
    } catch {
      return { answers: {} };
    }
  }

  onFileChangePatch(itemId: string, paths: string[]): void {
    this.pendingFileChanges.set(itemId, paths);
    this.spec.onEvent?.({ type: 'activity' });
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
    if (item.type === 'fileChange') this.pendingFileChanges.delete(item.id);
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
    this.approvalController.abort(new Error('Codex session interrupted'));
    try {
      await this.connection.request('turn/interrupt', { threadId: this.sessionId }, 10_000);
    } catch { /* server may have exited */ }
  }

  async close(): Promise<void> {
    this.approvalController.abort(new Error('Codex session closed'));
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
    this.onClose();
  }

  completion(): Promise<AgentRunOutcome> {
    return this.resultPromise;
  }

  private async ask(request: Omit<ApprovalRequest, 'backend' | 'role' | 'label' | 'sessionId' | 'cwd'>): Promise<ApprovalDecision> {
    if (!this.spec.requestApproval) return 'deny';
    try {
      return await this.spec.requestApproval({
        backend: 'codex', role: this.spec.role, label: this.spec.label,
        sessionId: this.sessionId, cwd: this.spec.cwd, ...request
      }, this.approvalController.signal);
    } catch {
      return 'deny';
    }
  }
}

export function codexDecision(decision: ApprovalDecision): 'accept' | 'acceptForSession' | 'decline' {
  if (decision === 'session') return 'acceptForSession';
  return decision === 'once' ? 'accept' : 'decline';
}

function deniedPermissionResponse(): PermissionsRequestApprovalResponse {
  return { permissions: {}, scope: 'turn' };
}

function grantablePermissions(
  requested: PermissionsRequestApprovalParams['permissions'],
  access: 'read-only' | 'workspace-write'
): GrantedPermissionProfile {
  const permissions: GrantedPermissionProfile = {};
  if (requested.network) permissions.network = requested.network;
  if (requested.fileSystem) {
    permissions.fileSystem = access === 'workspace-write'
      ? requested.fileSystem
      : {
          ...requested.fileSystem,
          write: [],
          ...(requested.fileSystem.entries ? {
            entries: requested.fileSystem.entries.filter((entry) => entry.access !== 'write')
          } : {})
        };
  }
  return permissions;
}

export function legacyReviewDecision(decision: 'accept' | 'acceptForSession' | 'decline'): ReviewDecision {
  if (decision === 'acceptForSession') return 'approved_for_session';
  return decision === 'decline' ? { denied: { rejection: 'denied by user' } } : 'approved';
}
