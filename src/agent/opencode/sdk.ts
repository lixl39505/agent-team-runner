import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/client';
import {
  createOpencodeClient as createOpencodeV2Client,
  type OpencodeClient as OpencodeV2Client,
  type QuestionInfo
} from '@opencode-ai/sdk/v2/client';
import { assertSessionCapabilities } from '../types.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentRunOutcome,
  AgentSession,
  DiscoveryResult,
  ModelInfo,
  PlatformCheckResult,
  ProbeResult,
  SessionSpec
} from '../types.js';
import type { BackendId } from '../../core/types.js';
import type { NativeWindowsSandboxPolicy } from '../../core/types.js';
import { compileOpenCode, compileOpenCodeBasePermission } from './policy.js';
import { parseAgentJson } from '../parse.js';
import { sanitizedEnv } from '../env.js';
import { denialGuidance } from '../../core/approval-collector.js';
import { killProcessTree } from '../process-tree.js';
import { unsupportedNativeWindowsSandbox } from '../platform.js';

export interface OpenCodeBackendOptions {
  command?: string | undefined;
  hostname?: string | undefined;
  port?: number | undefined;
  nativeWindowsSandbox?: NativeWindowsSandboxPolicy | undefined;
  /** Test seam; production always uses process.platform. */
  platform?: NodeJS.Platform | undefined;
  /** Test seam; production uses cross-spawn. */
  spawn?: typeof spawn | undefined;
  /** Explicit runtime environment, used by profile-isolated servers. */
  env?: Record<string, string | undefined> | undefined;
  /** Do not inherit ambient backend authentication variables. */
  minimalEnv?: boolean | undefined;
}

interface OpenCodeMessagePart {
  type?: string;
  text?: string;
  state?: string;
  tool?: string;
}

interface OpenCodeMessage {
  id?: string;
  role?: string;
  parts?: OpenCodeMessagePart[];
  info?: { modelID?: string; providerID?: string; tokens?: { input?: number; output?: number }; structured?: unknown };
}

/**
 * opencode 后端：受管一个 `opencode serve`（createOpencode 自动起 server+client），
 * 结构化输出双通道（prompt 内嵌 schema + 服务端 format 字段），SSE 权限请求
 * 转发到前台审批处理器并映射为 once/always/reject。
 */
export class OpenCodeBackend implements AgentBackend {
  readonly id: BackendId = 'opencode';
  readonly capabilities = { maxTurns: false, resumeSession: true };
  private clientPromise: Promise<OpencodeClient> | null = null;
  private questionClient: OpencodeV2Client | null = null;
  private serverChild: ChildProcess | null = null;
  private readonly sessions = new Map<string, OpenCodeAgentSession>();
  private subscribed = false;
  private subscribePromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** SSE 事件流：dispose 时必须终结，否则打开的 fetch 连接会钉住事件循环（进程无法退出） */
  private eventStream: AsyncGenerator<unknown> | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly nativeWindowsSandbox: NativeWindowsSandboxPolicy;

  constructor(private readonly options: OpenCodeBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.nativeWindowsSandbox = options.nativeWindowsSandbox ?? 'require';
  }

  async checkPlatform(): Promise<PlatformCheckResult> {
    return unsupportedNativeWindowsSandbox('opencode', this.nativeWindowsSandbox, this.platform);
  }

  private get command(): string {
    return this.options.command ?? 'opencode';
  }

  private get spawn(): typeof spawn {
    return this.options.spawn ?? spawn;
  }

  async discover(): Promise<DiscoveryResult> {
    return await new Promise<DiscoveryResult>((resolve) => {
      let child;
      try {
        child = this.spawn(this.command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve({ backend: 'opencode', installed: false, detail: `failed to spawn ${this.command}` });
        return;
      }
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ backend: 'opencode', installed: false, detail: 'version probe timed out' });
      }, 10_000);
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ backend: 'opencode', installed: false, detail: `failed to spawn ${this.command}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          backend: 'opencode',
          installed: code === 0,
          version: stdout.trim() || undefined,
          ...(code === 0 ? {} : { detail: `exit ${code}` })
        });
      });
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = await this.ensureClient();
    const response = await client.config.providers();
    const providers = (response.data?.providers ?? []) as Array<{
      id?: string;
      models?: Record<string, { id?: string; name?: string }>;
      npm?: string;
      error?: string;
    }>;
    const models: ModelInfo[] = [];
    for (const provider of providers) {
      if (!provider.id || provider.error) continue;
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        models.push({ id: `${provider.id}/${modelId}`, displayName: model?.name });
      }
    }
    return models;
  }

  async probe(model?: string | undefined): Promise<ProbeResult> {
    const started = Date.now();
    const scratch = mkdtempSync(join(tmpdir(), 'agent-team-opencode-probe-'));
    const session = await this.openSession({
      role: 'reviewer',
      cwd: scratch,
      prompt: 'Reply with exactly: ok',
      schema: { type: 'string' },
      access: 'read-only',
      timeoutMs: 90_000,
      staleAfterMs: 90_000,
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
    assertSessionCapabilities(this, spec);
    const platform = await this.checkPlatform();
    if (!platform.ok) throw new Error(platform.detail);
    const client = await this.ensureClient();
    await this.ensureSubscribed(client);
    const sessionId = spec.resumeSessionId === undefined
      ? await this.createSession(client, spec)
      : await this.resumeSession(client, spec);
    const session = new OpenCodeAgentSession(
      client, this.questionClient!, sessionId, spec, compileOpenCode(spec.access),
      () => this.sessions.delete(sessionId)
    );
    this.sessions.set(sessionId, session);
    // SSE may have ended between session.create and registration. Do not run a
    // prompt without its permission/event channel.
    try {
      await this.ensureSubscribed(client);
    } catch (error) {
      await session.close();
      throw error;
    }
    spec.onEvent?.({ type: 'session', sessionId });
    return session;
  }

  private async createSession(client: OpencodeClient, spec: SessionSpec): Promise<string> {
    const created = await client.session.create({
      query: { directory: spec.cwd },
      body: { title: `agent-team ${spec.role}` }
    });
    const sessionId = created.data?.id;
    if (!sessionId) throw new Error('opencode session creation returned no id');
    return sessionId;
  }

  private async resumeSession(client: OpencodeClient, spec: SessionSpec): Promise<string> {
    const sessionId = spec.resumeSessionId!;
    let existing: Awaited<ReturnType<typeof client.session.get>>;
    try {
      existing = await client.session.get({ path: { id: sessionId }, query: { directory: spec.cwd } });
    } catch (error) {
      throw new Error(`opencode resume session "${sessionId}" could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!existing.data) throw new Error(`opencode resume session "${sessionId}" was not found or is unreadable`);
    if (existing.data.directory !== spec.cwd) {
      throw new Error(`opencode resume session "${sessionId}" directory does not match requested cwd`);
    }
    let statuses: Awaited<ReturnType<typeof client.session.status>>;
    try {
      statuses = await client.session.status({ query: { directory: spec.cwd } });
    } catch (error) {
      throw new Error(`opencode resume session "${sessionId}" status could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const status = statuses.data?.[sessionId];
    if (!status) throw new Error(`opencode resume session "${sessionId}" status is unavailable`);
    if (status.type !== 'idle') throw new Error(`opencode resume session "${sessionId}" is not idle (${status.type})`);
    return sessionId;
  }

  handleEvent(event: { type?: string; properties?: Record<string, unknown> }): void {
    const properties = event.properties ?? {};
    const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : undefined;
    if (event.type === 'permission.updated') {
      const permission = properties as unknown as { id?: string; sessionID?: string; type?: string; pattern?: string | Array<string> };
      const session = permission.sessionID ? this.sessions.get(permission.sessionID) : undefined;
      if (session && permission.id) {
        void session.answerPermission(permission.id, { type: String(permission.type ?? ''), ...(permission.pattern !== undefined ? { pattern: permission.pattern } : {}) });
      } else if (permission.id && permission.sessionID) {
        // 未知会话的权限请求：fail-closed 拒绝
        void this.rejectPermission(permission.sessionID, permission.id);
      }
      return;
    }
    if (event.type === 'question.asked') {
      const request = properties as unknown as { id?: string; sessionID?: string; questions?: QuestionInfo[] };
      const session = request.sessionID ? this.sessions.get(request.sessionID) : undefined;
      if (session && request.id && request.questions) {
        void session.answerQuestion(request.id, request.questions);
      } else if (request.id) {
        void this.rejectQuestion(request.id);
      }
      return;
    }
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (event.type === 'session.idle') {
      session?.onSessionStatus('idle');
      return;
    }
    if (event.type === 'session.status') {
      session?.onSessionStatus(mapOpenCodeSessionStatus(properties.status));
      return;
    }
    if (event.type === 'message.updated' || event.type === 'message.part.updated') {
      const part = eventPart(properties);
      if (part.text) session?.onMessage(part.text);
      if (part.tool) session?.onTool(part.tool, part.state);
      session?.onActivity();
      return;
    }
    if (event.type === 'session.diff') {
      session?.onActivity();
    }
  }

  private async rejectPermission(sessionId: string, permissionId: string): Promise<void> {
    try {
      const client = await this.ensureClient();
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response: 'reject' }
      });
    } catch { /* session may be gone */ }
  }

  private async rejectQuestion(requestId: string): Promise<void> {
    try {
      await this.questionClient?.question.reject({ requestID: requestId });
    } catch { /* session may be gone */ }
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) void session.interrupt();
    this.sessions.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // 终结 SSE 订阅流，释放其底层连接
    if (this.eventStream) {
      void this.eventStream.return?.(undefined).catch(() => {});
      this.eventStream = null;
    }
    this.subscribePromise = null;
    this.killServer();
    this.clientPromise = null;
    this.questionClient = null;
    this.subscribed = false;
  }

  /**
   * 自管 `opencode serve` 子进程 + 仅用 SDK 的 client 连接。
   * 不用 createOpencode() 的托管模式：其 server 关闭是黑盒（实测会留下未销毁的
   * stdio 管道句柄钉住事件循环，宿主进程无法退出），且硬编码 opencode 命令名、
   * 无法应用 backends.opencode.command 覆盖。
   */
  private ensureClient(): Promise<OpencodeClient> {
    this.clientPromise ??= this.launchServer();
    return this.clientPromise;
  }

  private async launchServer(): Promise<OpencodeClient> {
    const command = this.options.command ?? 'opencode';
    const hostname = this.options.hostname ?? '127.0.0.1';
    const port = this.options.port ?? 4100 + Math.floor(Math.random() * 800);
    const child = this.spawn(command, ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...sanitizedEnv(this.options.env),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: compileOpenCodeBasePermission()
        })
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: this.platform !== 'win32'
    });
    this.serverChild = child;
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        reject(new Error(`opencode serve did not start within 15s; output: ${output.slice(0, 300)}`));
      }, 15_000);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        output += chunk;
        const match = output.match(/opencode server listening on (https?:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => { output += chunk; });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve exited with ${code}: ${output.slice(0, 300)}`));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    child.once('exit', () => {
      if (this.serverChild !== child) return;
      for (const session of [...this.sessions.values()]) void session.interrupt();
      this.sessions.clear();
      this.serverChild = null;
      this.clientPromise = null;
      this.questionClient = null;
      this.subscribed = false;
      if (this.eventStream) {
        void this.eventStream.return?.(undefined).catch(() => {});
        this.eventStream = null;
      }
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.subscribePromise = null;
    });
    this.questionClient = createOpencodeV2Client({ baseUrl: url });
    return createOpencodeClient({ baseUrl: url });
  }

  private killServer(): void {
    const child = this.serverChild;
    this.serverChild = null;
    if (!child) return;
    // 显式销毁 stdio 流：子进程死后未销毁的管道句柄会钉住事件循环
    try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
    try {
      killProcessTree(child, 'SIGTERM');
      // ref'd 的 SIGKILL 升级（与 codex jsonrpc 相同的语义）
      setTimeout(() => {
        try {
          killProcessTree(child, 'SIGKILL');
        } catch { /* already exited */ }
      }, 3_000);
    } catch { /* already exited */ }
  }

  private async ensureSubscribed(client: OpencodeClient): Promise<void> {
    if (this.subscribePromise) return await this.subscribePromise;
    const subscription = this.startSubscription(client);
    this.subscribePromise = subscription;
    try {
      await subscription;
    } catch (error) {
      if (this.subscribePromise === subscription) this.subscribePromise = null;
      throw error;
    }
  }

  private async startSubscription(client: OpencodeClient): Promise<void> {
    const { stream } = await client.event.subscribe();
    const eventStream = stream as AsyncGenerator<unknown>;
    this.eventStream = eventStream;
    this.subscribed = true;
    void this.consumeSubscription(client, eventStream);
  }

  private async consumeSubscription(client: OpencodeClient, stream: AsyncGenerator<unknown>): Promise<void> {
    try {
      for await (const item of stream) {
        const event = normalizeEvent(item);
        if (event) this.handleEvent(event);
      }
    } catch { /* server closed or subscription dropped */ } finally {
      if (this.eventStream !== stream) return;
      this.eventStream = null;
      this.subscribed = false;
      this.subscribePromise = null;
      this.scheduleResubscribe(client);
    }
  }

  private scheduleResubscribe(client: OpencodeClient): void {
    if (!this.serverChild || this.sessions.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.serverChild || this.subscribed) return;
      void this.ensureSubscribed(client).catch(() => this.scheduleResubscribe(client));
    }, 100);
  }
}

/** SSE 载荷形状兼容：{type, properties} 信封 或 展开的 properties 本身 */
function normalizeEvent(item: unknown): { type?: string; properties?: Record<string, unknown> } | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  if (typeof record.type === 'string' && record.properties && typeof record.properties === 'object') {
    return { type: record.type, properties: record.properties as Record<string, unknown> };
  }
  // 展开的权限请求（带 id + sessionID）
  if (typeof record.id === 'string' && typeof record.sessionID === 'string') {
    return { type: 'permission.updated', properties: record };
  }
  if (typeof record.sessionID === 'string') return { type: 'message.updated', properties: record };
  return null;
}

class OpenCodeAgentSession implements AgentSession {
  readonly sessionId: string;
  private interrupted = false;
  private readonly resultPromise: Promise<AgentRunOutcome>;
  private readonly approvalController = new AbortController();
  private abortPromise: Promise<void> | null = null;

  constructor(
    private readonly client: OpencodeClient,
    private readonly questionClient: OpencodeV2Client,
    sessionId: string,
    private readonly spec: SessionSpec,
    private readonly compiled: ReturnType<typeof compileOpenCode>,
    private readonly onClose: () => void
  ) {
    this.sessionId = sessionId;
    this.resultPromise = this.run();
  }

  private async run(): Promise<AgentRunOutcome> {
    const model = this.spec.model !== undefined && this.spec.model.includes('/')
      ? { providerID: this.spec.model.split('/')[0]!, modelID: this.spec.model.slice(this.spec.model.indexOf('/') + 1) }
      : undefined;
    const promptWithSchema = `${this.spec.prompt}

Return the final answer as one JSON object matching this schema exactly:
${JSON.stringify(this.spec.schema)}`;
    try {
      const response = await this.client.session.prompt({
        path: { id: this.sessionId },
        query: { directory: this.spec.cwd },
        body: {
          parts: [{ type: 'text', text: promptWithSchema }],
          ...(model ? { model } : {}),
          // SDK 类型滞后于服务端：format 字段文档已公布（结构化输出 + 重试）
          format: { type: 'json_schema', schema: this.spec.schema, retryCount: 1 }
        } as never
      });
      const info = Object(response.data?.info) as NonNullable<OpenCodeMessage['info']> & { error?: { name?: string; data?: { message?: string } } };
      const tokens = info.tokens;
      const usage = tokens ? { inputTokens: tokens.input, outputTokens: tokens.output } : undefined;
      // opencode 把 provider 错误放在 info.error（如 401 认证失败）——显式透出
      if (info.error) {
        const detail = info.error.data?.message ?? info.error.name ?? 'unknown provider error';
        return {
          ok: false,
          output: null,
          error: `opencode provider error: ${detail}`,
          timedOut: this.interrupted,
          stalled: false,
          sessionId: this.sessionId
        };
      }
      // 双通道：优先服务端 structured 输出，退回最终文本解析
      if (info.structured !== undefined && info.structured !== null) {
        return { ok: true, output: info.structured, timedOut: false, stalled: false, sessionId: this.sessionId, ...(usage ? { usage } : {}) };
      }
      const parts = (response.data?.parts ?? []) as OpenCodeMessagePart[];
      const text = parts.filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
      if (usage) this.spec.onEvent?.({
        type: 'usage',
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {})
      });
      if (text) this.spec.onEvent?.({ type: 'message', text });
      if (!text) {
        return {
          ok: false,
          output: null,
          error: 'opencode turn produced no final message',
          timedOut: this.interrupted,
          stalled: false,
          sessionId: this.sessionId,
          ...(usage ? { usage } : {})
        };
      }
      try {
        return { ok: true, output: parseAgentJson(text), timedOut: false, stalled: false, sessionId: this.sessionId, ...(usage ? { usage } : {}) };
      } catch (error) {
        return {
          ok: false,
          output: null,
          error: (error as Error).message,
          timedOut: this.interrupted,
          stalled: false,
          sessionId: this.sessionId
        };
      }
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        timedOut: this.interrupted,
        stalled: false,
        sessionId: this.sessionId
      };
    }
  }

  onActivity(): void {
    this.spec.onEvent?.({ type: 'activity' });
  }

  onSessionStatus(status: 'idle' | 'busy' | 'error'): void {
    this.spec.onEvent?.({ type: 'session-status', status });
  }

  onMessage(text: string): void {
    this.spec.onEvent?.({ type: 'message', text });
  }

  onTool(tool: string, state: string | undefined): void {
    if (state === 'completed' || state === 'error') {
      this.spec.onEvent?.({ type: 'tool-result', tool, ok: state === 'completed' });
      return;
    }
    this.spec.onEvent?.({ type: 'tool-call', tool, input: {} });
  }

  async answerPermission(permissionId: string, request: { type: string; pattern?: string | Array<string> | undefined }): Promise<void> {
    const hardDenied = this.compiled.access === 'read-only' && ['bash', 'edit'].includes(request.type);
    const kind = openCodeApprovalKind(request.type);
    let response: 'once' | 'always' | 'reject' = 'reject';
    if (!hardDenied && this.compiled.access === 'workspace-write' && request.type === 'edit') {
      response = 'once';
    } else if (!hardDenied && this.spec.requestApproval) {
      try {
        const decision = await this.spec.requestApproval({
          backend: 'opencode',
          role: this.spec.role,
          label: this.spec.label,
          sessionId: this.sessionId,
          ...(this.spec.taskId !== undefined ? { taskId: this.spec.taskId } : {}),
          cwd: this.spec.cwd,
          kind,
          tool: request.type,
          input: { ...(request.pattern !== undefined ? { pattern: request.pattern } : {}) },
          title: openCodeApprovalTitle(request),
          allowSession: true
        }, this.approvalController.signal);
        response = decision === 'session' ? 'always' : decision === 'once' ? 'once' : 'reject';
      } catch {
        response = 'reject';
      }
    }
    this.spec.onEvent?.({
      type: 'permission-check',
      tool: request.type,
      input: { ...(request.pattern !== undefined ? { pattern: request.pattern } : {}) },
      allowed: response !== 'reject',
      ...(response === 'reject' ? { reason: hardDenied ? 'read-only role' : denialGuidance } : {})
    });
    try {
      await this.client.postSessionIdPermissionsPermissionId({
        path: { id: this.sessionId, permissionID: permissionId },
        body: { response }
      });
    } catch { /* session may be gone */ }
  }

  async answerQuestion(requestId: string, questions: QuestionInfo[]): Promise<void> {
    if (!this.spec.requestUserInput) {
      try { await this.questionClient.question.reject({ requestID: requestId, directory: this.spec.cwd }); } catch { /* session may be gone */ }
      return;
    }
    try {
      const normalized = questions.map((question, index) => ({
        id: String(index),
        header: question.header,
        question: question.question,
        options: question.options,
        multiple: question.multiple,
        allowCustom: question.custom !== false
      }));
      const answers = await this.spec.requestUserInput({
        backend: 'opencode', role: this.spec.role, label: this.spec.label,
        sessionId: this.sessionId, ...(this.spec.taskId !== undefined ? { taskId: this.spec.taskId } : {}),
        cwd: this.spec.cwd, questions: normalized
      }, this.approvalController.signal);
      await this.questionClient.question.reply({
        requestID: requestId,
        directory: this.spec.cwd,
        answers: normalized.map((question) => answers[question.id] ?? [])
      });
      this.spec.onEvent?.({ type: 'activity' });
    } catch {
      try { await this.questionClient.question.reject({ requestID: requestId, directory: this.spec.cwd }); } catch { /* session may be gone */ }
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.approvalController.abort(new Error('OpenCode session interrupted'));
    await this.abortRemote();
  }

  async close(): Promise<void> {
    this.approvalController.abort(new Error('OpenCode session closed'));
    await this.abortRemote();
    this.onClose();
  }

  completion(): Promise<AgentRunOutcome> {
    return this.resultPromise;
  }

  private abortRemote(): Promise<void> {
    this.abortPromise ??= (async () => {
      try {
        await this.client.session.abort({ path: { id: this.sessionId } });
      } catch {
        // The session may have completed or the server may already be gone.
      }
    })();
    return this.abortPromise!;
  }
}

function eventPart(properties: Record<string, unknown>): OpenCodeMessagePart {
  const candidate = properties.part;
  return candidate && typeof candidate === 'object'
    ? candidate as OpenCodeMessagePart
    : properties as OpenCodeMessagePart;
}

export function mapOpenCodeSessionStatus(status: unknown): 'idle' | 'busy' | 'error' {
  if (!status || typeof status !== 'object') return 'error';
  const type = (status as { type?: unknown }).type;
  if (type === 'idle') return 'idle';
  return type === 'busy' || type === 'retry' ? 'busy' : 'error';
}

function openCodeApprovalKind(type: string): 'command' | 'file-change' | 'network' | 'external-directory' | 'tool' {
  if (type === 'bash') return 'command';
  if (type === 'edit') return 'file-change';
  if (type === 'webfetch' || type === 'websearch') return 'network';
  if (type === 'external_directory') return 'external-directory';
  return 'tool';
}

function openCodeApprovalTitle(request: { type: string; pattern?: string | Array<string> | undefined }): string {
  const pattern = Array.isArray(request.pattern) ? request.pattern.join(', ') : request.pattern;
  return pattern ? `OpenCode requests ${request.type}: ${pattern}` : `OpenCode requests ${request.type} permission`;
}
