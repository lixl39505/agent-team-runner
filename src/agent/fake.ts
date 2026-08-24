import type { AgentBackend, AgentEvent, AgentRunOutcome, AgentSession, DiscoveryResult, ModelInfo, ProbeResult, SessionSpec } from './types.js';
import type { BackendId } from '../core/types.js';

export interface FakeScript {
  /** 按序发出的事件 */
  events?: AgentEvent[];
  /** completion 的结构化输出 */
  output?: unknown;
  /** completion reject 的错误 */
  error?: string;
  /** 每个事件之间的延迟（默认 5ms） */
  stepMs?: number;
  /** 最后一个事件后、resolve 前的额外延迟 */
  tailMs?: number;
  /** 完全不产生事件（测静默监督） */
  silent?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeBackend implements AgentBackend {
  readonly id: BackendId;
  readonly sessions: FakeSession[] = [];

  constructor(
    script: FakeScript = {},
    readonly models: ModelInfo[] = [],
    id: BackendId = 'claude'
  ) {
    this.script = script;
    this.id = id;
  }

  private script: FakeScript;

  discover(): Promise<DiscoveryResult> {
    return Promise.resolve({ backend: this.id, installed: true, version: 'fake-1.0', authed: true });
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.models);
  }

  probe(): Promise<ProbeResult> {
    return Promise.resolve({ ok: true, latencyMs: 1 });
  }

  async openSession(spec: SessionSpec): Promise<AgentSession> {
    const session = new FakeSession(this.script, spec);
    this.sessions.push(session);
    return session;
  }
}

export class FakeSession implements AgentSession {
  sessionId?: string | undefined;
  interruptCount = 0;
  closeCount = 0;

  constructor(
    private readonly script: FakeScript,
    private readonly spec: SessionSpec
  ) {}

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  completion(): Promise<AgentRunOutcome> {
    return new Promise<AgentRunOutcome>((resolve, reject) => {
      void (async () => {
        try {
          if (!this.script.silent) {
            for (const event of this.script.events ?? []) {
              if (this.interruptCount > 0) break;
              await sleep(this.script.stepMs ?? 5);
              if (this.interruptCount > 0) break;
              this.spec.onEvent?.(event);
            }
            await sleep(this.script.tailMs ?? 0);
          } else {
            // silent：直到被中断前完全不产生事件
            while (this.interruptCount === 0) await sleep(10);
          }
          if (this.script.error !== undefined) {
            reject(new Error(this.script.error));
            return;
          }
          if (this.interruptCount > 0) {
            resolve({ ok: false, output: null, error: 'interrupted', timedOut: false, stalled: false });
            return;
          }
          this.spec.onEvent?.({ type: 'activity' });
          resolve({
            ok: true,
            output: this.script.output ?? null,
            timedOut: false,
            stalled: false,
            ...(this.sessionId ? { sessionId: this.sessionId } : {})
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }
}
