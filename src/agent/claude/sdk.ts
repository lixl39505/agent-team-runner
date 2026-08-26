import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query, type Options, type PermissionUpdate, type Query } from '@anthropic-ai/claude-agent-sdk';
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
  private readonly sessions = new Set<ClaudeAgentSession>();

  constructor(
    private readonly options: ClaudeBackendOptions = {},
    private readonly queryFactory: typeof query = query
  ) {}

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
    const q = this.queryFactory({ prompt: '', options: this.baseOptions({}) });
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
      const q = this.queryFactory({
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
    const compiled = compileClaude(spec.access);
    const controller = new AbortController();
    const options: Options = this.baseOptions({
      cwd: spec.cwd,
      sandbox: compileSandbox(spec),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      permissionMode: compiled.permissionMode,
      settingSources: spec.access === 'read-only' ? [] : ['user', 'project', 'local'],
      allowedTools: compiled.allowedTools,
      disallowedTools: compiled.disallowedTools,
      canUseTool: async (toolName, input, context) => {
        if (spec.access === 'read-only' && !readOnlyApprovableTool(toolName)) {
          const reason = `tool ${toolName} is outside the read-only role boundary`;
          spec.onEvent?.({ type: 'permission-check', tool: toolName, input, allowed: false, reason });
          return { behavior: 'deny', message: reason };
        }
        if (!spec.requestApproval) {
          const reason = 'no approval handler is available';
          spec.onEvent?.({ type: 'permission-check', tool: toolName, input, allowed: false, reason });
          return { behavior: 'deny', message: reason };
        }
        let decision: 'once' | 'session' | 'deny';
        try {
          decision = await spec.requestApproval({
            backend: 'claude',
            role: spec.role,
            label: spec.label,
            cwd: spec.cwd,
            kind: claudeApprovalKind(toolName, context.blockedPath),
            tool: toolName,
            input,
            title: context.title,
            description: context.description,
            reason: context.decisionReason,
            allowSession: (context.suggestions?.length ?? 0) > 0
          }, context.signal);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          spec.onEvent?.({ type: 'permission-check', tool: toolName, input, allowed: false, reason });
          return { behavior: 'deny', message: reason };
        }
        spec.onEvent?.({
          type: 'permission-check',
          tool: toolName,
          input,
          allowed: decision !== 'deny',
          ...(decision === 'deny' ? { reason: 'denied by user' } : {})
        });
        if (decision === 'deny') return { behavior: 'deny', message: 'Denied by user.' };
        return {
          behavior: 'allow',
          ...(decision === 'session' && context.suggestions ? {
            updatedPermissions: context.suggestions.map(sessionPermission)
          } : {})
        };
      },
      outputFormat: { type: 'json_schema', schema: spec.schema as Record<string, unknown> },
      ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
      includePartialMessages: true,
      abortController: controller,
      ...(spec.resumeSessionId !== undefined ? { resume: spec.resumeSessionId } : {})
    });
    const q = this.queryFactory({ prompt: spec.prompt, options });
    const session = new ClaudeAgentSession(q, controller, spec, () => this.sessions.delete(session));
    this.sessions.add(session);
    return session;
  }

  dispose(): void {
    for (const session of [...this.sessions]) void session.close();
    this.sessions.clear();
  }

  private baseOptions(overrides: Partial<Options>): Options {
    return {
      env: sanitizedEnv(),
      // Match Claude Code: native settings may pre-authorize operations; remaining asks reach canUseTool.
      settingSources: ['user', 'project', 'local'],
      ...(this.options.command ? { pathToClaudeCodeExecutable: this.options.command } : {}),
      ...overrides
    } as Options;
  }
}

function compileSandbox(spec: SessionSpec): NonNullable<Options['sandbox']> {
  const gitPaths = gitMetadataPaths(spec.cwd);
  const denyWrite = spec.access === 'read-only'
    ? [spec.cwd, ...gitPaths]
    : gitPaths;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    filesystem: {
      disabled: false,
      denyWrite: [...new Set(denyWrite)]
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false
  };
}

function sessionPermission(update: PermissionUpdate): PermissionUpdate {
  return { ...update, destination: 'session' };
}

function claudeApprovalKind(toolName: string, blockedPath?: string): 'command' | 'file-change' | 'network' | 'external-directory' | 'tool' {
  if (blockedPath) return 'external-directory';
  const normalized = toolName.toLowerCase();
  if (normalized === 'bash') return 'command';
  if (['edit', 'write', 'notebookedit'].includes(normalized)) return 'file-change';
  if (['webfetch', 'websearch'].includes(normalized)) return 'network';
  return 'tool';
}

function readOnlyApprovableTool(toolName: string): boolean {
  return ['bash', 'webfetch', 'websearch'].includes(toolName.toLowerCase());
}

/** Resolve linked-worktree Git metadata so the command sandbox cannot mutate history or hooks. */
function gitMetadataPaths(cwd: string): string[] {
  const dotGit = join(cwd, '.git');
  try {
    const marker = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!marker) return [dotGit];
    const gitDir = resolve(cwd, marker);
    try {
      const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
      return [dotGit, gitDir, resolve(gitDir, common)];
    } catch {
      return [dotGit, gitDir];
    }
  } catch {
    return [dotGit];
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
    private readonly spec: SessionSpec,
    private readonly onClose: () => void
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
    this.onClose();
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
