import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentBackend, AgentEvent, AgentRunOutcome, AgentSession, SessionSpec } from './types.js';
import { writeJson } from '../core/files.js';

/** interrupt 之后等待 completion 自然结算的宽限期，超时则强 close */
const TERMINATION_GRACE_MS = 15_000;

/** 连续权限拒绝熔断阈值：模型陷入 deny-thrash 时快速失败，避免烧尽上下文/预算 */
const MAX_CONSECUTIVE_DENIES = 10;

export interface RunAgentInput {
  backend: AgentBackend;
  spec: SessionSpec;
  logPath: string;
  outputPath: string;
}

/**
 * 单次 agent 调用的监督器：openSession → 事件泵（日志/心跳/静默计时）→
 * 超时/静默 interrupt（+宽限强杀）→ close → 落盘结构化输出。
 */
export async function runAgent<T = unknown>(input: RunAgentInput): Promise<AgentRunOutcome<T>> {
  const { backend, spec } = input;
  mkdirSync(dirname(input.logPath), { recursive: true });
  mkdirSync(dirname(input.outputPath), { recursive: true });
  writeFileSync(input.logPath, '', 'utf8');
  const append = (line: string): void => { appendFileSync(input.logPath, `${line}\n`, 'utf8'); };

  let session: AgentSession;
  let lastActivity = Date.now();
  // 后置钩子：session 打开后才挂上 deny-thrash 跟踪（避免 TDZ）
  let postEvent: ((event: AgentEvent) => void) | null = null;
  try {
    const wrapped: SessionSpec = {
      ...spec,
      onEvent: (event) => {
        lastActivity = Date.now();
        append(`[event] ${JSON.stringify(event)}`);
        spec.onEvent?.(event);
        postEvent?.(event);
      }
    };
    session = await backend.openSession(wrapped);
    append(`[session] opened on backend ${backend.id}`);
  } catch (error) {
    return failure(`failed to open ${backend.id} session: ${errorMessage(error)}`) as unknown as AgentRunOutcome<T>;
  }

  let timedOut = false;
  let stalled = false;
  let deniedInARow = 0;
  let thrashed = false;
  let settled = false;
  let graceTimer: NodeJS.Timeout | null = null;

  // 权限拒绝计数（防 deny-thrash）：任何放行的裁决或非权限事件都会重置
  const trackDenies = (event: AgentEvent): void => {
    if (event.type === 'permission-check' && !event.allowed) {
      deniedInARow += 1;
      if (deniedInARow >= MAX_CONSECUTIVE_DENIES) {
        thrashed = true;
        requestInterrupt();
      }
    } else {
      deniedInARow = 0;
    }
  };

  const requestInterrupt = (): void => {
    append(`[supervisor] interrupt requested (timedOut=${timedOut} stalled=${stalled} thrashed=${thrashed})`);
    if (!graceTimer) {
      graceTimer = setTimeout(() => {
        append('[supervisor] grace expired, closing transport');
        void session.close().catch(() => {});
      }, TERMINATION_GRACE_MS);
    }
    void session.interrupt().catch(() => {});
  };
  postEvent = trackDenies;

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    requestInterrupt();
  }, spec.timeoutMs);
  const stallInterval = setInterval(() => {
    if (Date.now() - lastActivity > spec.staleAfterMs) {
      stalled = true;
      requestInterrupt();
    }
  }, Math.min(5000, Math.max(1000, Math.floor(spec.staleAfterMs / 4))));

  let outcome: AgentRunOutcome;
  try {
    outcome = await new Promise<AgentRunOutcome>((resolve, reject) => {
      session.completion().then(
        (result) => { settled = true; resolve(result); },
        (error) => { settled = true; reject(error); }
      );
    });
  } catch (error) {
    append(`[session] transport failure: ${errorMessage(error)}`);
    outcome = failure(`session failed: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(stallInterval);
    if (graceTimer) clearTimeout(graceTimer);
    await session.close().catch(() => {});
    append(`[session] closed (settled=${String(settled)})`);
  }

  const merged: AgentRunOutcome = {
    ...outcome,
    timedOut: outcome.timedOut || timedOut,
    stalled: outcome.stalled || stalled
  };
  if (!merged.ok && thrashed) {
    // 覆盖后端自己的 "interrupted" 之类消息，给出可行动的监督原因
    merged.error = `agent hit ${MAX_CONSECUTIVE_DENIES} consecutive permission denials (policy thrash); widen the role's command prefixes or fix the task instructions`;
  } else if (!merged.ok && (timedOut || stalled)) {
    merged.error = timedOut
      ? `agent exceeded timeout of ${spec.timeoutMs}ms`
      : `agent made no progress for ${spec.staleAfterMs}ms`;
  }
  if (merged.output !== null && merged.output !== undefined) {
    writeJson(input.outputPath, merged.output);
    append('[session] structured output written');
  }
  return merged as unknown as AgentRunOutcome<T>;
}

function failure(error: string): AgentRunOutcome {
  return { ok: false, output: null, error, timedOut: false, stalled: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
