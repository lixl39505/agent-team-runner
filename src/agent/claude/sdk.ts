import { spawn } from 'node:child_process';
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
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
import { compileClaude } from './policy.js';
import { sanitizedEnv } from '../env.js';

export interface ClaudeBackendOptions {
  /** 覆盖 claude 可执行文件路径（backends.claude.command）；缺省用 SDK 内置二进制 */
  command?: string | undefined;
}

export class ClaudeBackend implements AgentBackend {
  readonly id: BackendId = 'claude';

  constructor(private readonly options: ClaudeBackendOptions = {}) {}

  async discover(): Promise<DiscoveryResult> {
    const command = this.options.command ?? 'claude';
    return await new Promise<DiscoveryResult>((resolve) => {
      let child;
      try {
        child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve({ backend: 'claude', installed: false, detail: `failed to spawn ${command}` });
        return;
      }
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ backend: 'claude', installed: false, detail: 'version probe timed out' });
      }, 10_000);
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ backend: 'claude', installed: false, detail: `failed to spawn ${command}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          backend: 'claude',
          installed: code === 0,
          version: stdout.trim() || undefined,
          ...(code === 0 ? {} : { detail: `exit ${code}` })
        });
      });
    });
  }

  /** 通过 SDK 的 supportedModels() 枚举当前登录可用的 model */
  async listModels(): Promise<ModelInfo[]> {
    const q = query({ prompt: '', options: this.baseOptions({}) });
    try {
      const models = await q.supportedModels();
      // 同时给出别名（value）与解析后的正式 id（resolvedModel），预检两者都算命中
      return models.flatMap((model) => {
        const entries: ModelInfo[] = [{ id: model.value, displayName: model.displayName }];
        if (model.resolvedModel && model.resolvedModel !== model.value) {
          entries.push({ id: model.resolvedModel, displayName: model.displayName });
        }
        return entries;
      });
    } finally {
      try { q.close(); } catch { /* already closed */ }
    }
  }

  /** 1-token 真实试跑 = 权威可用性验证 */
  async probe(model?: string | undefined): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const q = query({
        prompt: 'Reply with exactly: ok',
        options: this.baseOptions({
          ...(model ? { model } : {}),
          permissionMode: 'dontAsk',
          allowedTools: [],
          maxTurns: 1
        })
      });
      try {
        for await (const message of q) {
          if (message.type === 'result') {
            const ok = message.subtype === 'success' && !message.is_error;
            return {
              ok,
              ...(ok ? {} : { error: `probe failed: ${message.subtype}` }),
              latencyMs: Date.now() - started
            };
          }
        }
        return { ok: false, error: 'probe produced no result', latencyMs: Date.now() - started };
      } finally {
        try { q.close(); } catch { /* already closed */ }
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started
      };
    }
  }

  async openSession(spec: SessionSpec): Promise<AgentSession> {
    const compiled = compileClaude(spec.policy);
    const controller = new AbortController();
    const options: Options = this.baseOptions({
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      permissionMode: compiled.permissionMode,
      allowedTools: compiled.allowedTools,
      disallowedTools: compiled.disallowedTools,
      canUseTool: (toolName, input) => {
        const decision = compiled.decide(toolName, input, spec.cwd);
        spec.onEvent?.({
          type: 'permission-check',
          tool: toolName,
          input,
          allowed: decision.behavior === 'allow',
          ...(decision.behavior === 'deny' ? { reason: decision.message } : {})
        });
        if (decision.behavior === 'allow') {
          return Promise.resolve({ behavior: 'allow', ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}) });
        }
        return Promise.resolve({ behavior: 'deny', message: decision.message });
      },
      outputFormat: { type: 'json_schema', schema: spec.schema as Record<string, unknown> },
      ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
      includePartialMessages: true,
      abortController: controller,
      ...(spec.resumeSessionId !== undefined ? { resume: spec.resumeSessionId } : {})
    });
    const q = query({ prompt: spec.prompt, options });
    return new ClaudeAgentSession(q, controller, spec);
  }

  private baseOptions(overrides: Partial<Options>): Options {
    return {
      env: sanitizedEnv(),
      // 不加载用户/项目 settings 的权限规则——spike 实测它们的 allow 规则会 shadow
      // canUseTool（CLAUDE_SDK_CAN_USE_TOOL_SHADOWED），Runner policy 必须是唯一权威
      settingSources: [],
      ...(this.options.command ? { pathToClaudeCodeExecutable: this.options.command } : {}),
      ...overrides
    } as Options;
  }
}

/** SDKMessage → AgentEvent 的映射（纯函数，单测核心） */
export function mapClaudeMessage(message: { type: string } & Record<string, unknown>): AgentEvent[] | null {
  switch (message.type) {
    case 'stream_event':
      return [{ type: 'activity' }];
    case 'assistant': {
      const events: AgentEvent[] = [];
      const content = (message.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') events.push({ type: 'message', text: block.text });
        if (block.type === 'tool_use') events.push({ type: 'tool-call', tool: String(block.name), input: block.input });
      }
      return events.length > 0 ? events : [{ type: 'activity' }];
    }
    case 'user': {
      const content = (message.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        return content
          .filter((block) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_result')
          .map((block) => {
            const record = block as { tool_use_id?: string; is_error?: boolean; content?: unknown };
            const summary = typeof record.content === 'string' ? record.content.slice(0, 200) : undefined;
            return { type: 'tool-result', tool: record.tool_use_id ?? 'unknown', ok: record.is_error !== true, ...(summary ? { summary } : {}) } as AgentEvent;
          });
      }
      return [{ type: 'activity' }];
    }
    default:
      return [{ type: 'activity' }];
  }
}

export function mapClaudeResult(message: { type: string } & Record<string, unknown>): AgentRunOutcome {
  if (message.type !== 'result') throw new Error('mapClaudeResult expects a result message');
  const sessionId = typeof message.session_id === 'string' ? message.session_id : undefined;
  const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const usageEvent = usage
    ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
    : undefined;
  if (message.subtype === 'success') {
    const output = message.structured_output ?? null;
    return {
      ok: !message.is_error && output !== null,
      output,
      ...(!message.is_error && output !== null ? {} : {
        error: message.is_error
          ? `claude turn ended with error: ${String(message.result ?? '')}`
          : 'claude turn ended without structured output'
      }),
      timedOut: false,
      stalled: false,
      ...(sessionId ? { sessionId } : {}),
      ...(usageEvent ? { usage: usageEvent } : {})
    };
  }
  const errors = Array.isArray(message.errors) ? message.errors.map(String).join('; ') : String(message.subtype);
  return {
    ok: false,
    output: null,
    error: `claude turn failed (${String(message.subtype)}): ${errors}`,
    timedOut: false,
    stalled: false,
    ...(sessionId ? { sessionId } : {}),
    ...(usageEvent ? { usage: usageEvent } : {})
  };
}

class ClaudeAgentSession implements AgentSession {
  private readonly resultPromise: Promise<AgentRunOutcome>;
  private sessionUuid: string | undefined;

  constructor(
    private readonly q: Query,
    private readonly controller: AbortController,
    private readonly spec: SessionSpec
  ) {
    this.resultPromise = this.pump();
  }

  get sessionId(): string | undefined {
    return this.sessionUuid;
  }

  async interrupt(): Promise<void> {
    try {
      await this.q.interrupt();
    } catch {
      this.controller.abort();
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    try { this.q.close(); } catch { /* already closed */ }
  }

  completion(): Promise<AgentRunOutcome> {
    return this.resultPromise;
  }

  private async pump(): Promise<AgentRunOutcome> {
    try {
      for await (const message of this.q) {
        if (message.type === 'system' && typeof message.session_id === 'string') {
          this.sessionUuid = message.session_id;
          this.spec.onEvent?.({ type: 'session', sessionId: message.session_id });
        }
        for (const event of mapClaudeMessage(message as unknown as { type: string } & Record<string, unknown>) ?? []) {
          this.spec.onEvent?.(event);
        }
        if (message.type === 'result') {
          if (typeof message.session_id === 'string') this.sessionUuid = message.session_id;
          return mapClaudeResult(message as unknown as { type: string } & Record<string, unknown>);
        }
      }
      return { ok: false, output: null, error: 'claude session ended without a result message', timedOut: false, stalled: false };
    } catch (error) {
      return {
        ok: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
        stalled: false
      };
    }
  }
}
