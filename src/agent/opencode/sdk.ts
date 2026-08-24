import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/client';
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
import { compileOpenCode } from './policy.js';
import { parseAgentJson } from '../parse.js';
import { sanitizedEnv } from '../env.js';

export interface OpenCodeBackendOptions {
  command?: string | undefined;
  hostname?: string | undefined;
  port?: number | undefined;
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
 * 结构化输出双通道（prompt 内嵌 schema + 服务端 format 字段），权限经 SSE 事件
 * 由 Runner 策略应答 once/reject。
 */
export class OpenCodeBackend implements AgentBackend {
  readonly id: BackendId = 'opencode';
  private clientPromise: Promise<OpencodeClient> | null = null;
  private serverChild: ChildProcess | null = null;
  private readonly sessions = new Map<string, OpenCodeAgentSession>();
  private subscribed = false;
  /** SSE 事件流：dispose 时必须终结，否则打开的 fetch 连接会钉住事件循环（进程无法退出） */
  private eventStream: AsyncGenerator<unknown> | null = null;

  constructor(private readonly options: OpenCodeBackendOptions = {}) {}

  private get command(): string {
    return this.options.command ?? 'opencode';
  }

  async discover(): Promise<DiscoveryResult> {
    return await new Promise<DiscoveryResult>((resolve) => {
      let child;
      try {
        child = spawn(this.command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
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
      role: 'lead',
      cwd: scratch,
      prompt: 'Reply with exactly: ok',
      schema: { type: 'string' },
      policy: { fs: { mode: 'read-only' }, bash: { mode: 'deny' }, network: false },
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
    const client = await this.ensureClient();
    await this.ensureSubscribed(client);
    const created = await client.session.create({
      query: { directory: spec.cwd },
      body: { title: `agent-team ${spec.role}` }
    });
    const sessionId = created.data?.id;
    if (!sessionId) throw new Error('opencode session creation returned no id');
    const session = new OpenCodeAgentSession(client, sessionId, spec, compileOpenCode(spec.policy));
    this.sessions.set(sessionId, session);
    spec.onEvent?.({ type: 'session', sessionId });
    return session;
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
    if (!sessionId) return;
    if (event.type === 'message.updated' || event.type === 'message.part.updated' || event.type === 'session.diff') {
      this.sessions.get(sessionId)?.onActivity();
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

  dispose(): void {
    this.sessions.clear();
    // 终结 SSE 订阅流，释放其底层连接
    if (this.eventStream) {
      void this.eventStream.return?.(undefined).catch(() => {});
      this.eventStream = null;
    }
    this.killServer();
    this.clientPromise = null;
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
    const child = spawn(command, ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...sanitizedEnv(),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: 'ask', edit: 'ask', webfetch: 'ask' } })
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
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
    return createOpencodeClient({ baseUrl: url });
  }

  private killServer(): void {
    const child = this.serverChild;
    this.serverChild = null;
    if (!child) return;
    // 显式销毁 stdio 流：子进程死后未销毁的管道句柄会钉住事件循环
    try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
      // ref'd 的 SIGKILL 升级（与 codex jsonrpc 相同的语义）
      setTimeout(() => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* already exited */ }
      }, 3_000);
    } catch { /* already exited */ }
  }

  private async ensureSubscribed(client: OpencodeClient): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;
    try {
      const { stream } = await client.event.subscribe();
      this.eventStream = stream as AsyncGenerator<unknown>;
      void (async () => {
        try {
          for await (const item of stream) {
            const event = normalizeEvent(item);
            if (event) this.handleEvent(event);
          }
        } catch { /* server closed */ }
      })();
    } catch {
      this.subscribed = false;
    }
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

  constructor(
    private readonly client: OpencodeClient,
    sessionId: string,
    private readonly spec: SessionSpec,
    private readonly compiled: ReturnType<typeof compileOpenCode>
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
      const info = (response.data?.info ?? {}) as NonNullable<OpenCodeMessage['info']> & { error?: { name?: string; data?: { message?: string } } };
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
          error: error instanceof Error ? error.message : String(error),
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

  async answerPermission(permissionId: string, request: { type: string; pattern?: string | Array<string> | undefined }): Promise<void> {
    const decision = this.compiled.decide(request, this.spec.cwd);
    this.spec.onEvent?.({
      type: 'permission-check',
      tool: request.type,
      input: { ...(request.pattern !== undefined ? { pattern: request.pattern } : {}) },
      allowed: decision === 'once',
      ...(decision === 'reject' ? { reason: `runner policy denied ${request.type}` } : {})
    });
    try {
      await this.client.postSessionIdPermissionsPermissionId({
        path: { id: this.sessionId, permissionID: permissionId },
        body: { response: decision }
      });
    } catch { /* session may be gone */ }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    try {
      await this.client.session.abort({ path: { id: this.sessionId } });
    } catch { /* already idle */ }
  }

  async close(): Promise<void> {
    if (this.interrupted) return;
    // 会话保留在服务端（resume 能力预留）；不主动删除
  }

  completion(): Promise<AgentRunOutcome> {
    return this.resultPromise;
  }
}
