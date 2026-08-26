import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentBackend, AgentEvent, AgentRunOutcome, AgentSession, SessionSpec } from './types.js';
import { writeJson } from '../core/files.js';

/** interrupt 之后等待 completion 自然结算的宽限期，超时则强 close */
const TERMINATION_GRACE_MS = 15_000;

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
  const startedAt = Date.now();
  let pausedAt: number | null = null;
  let pausedMs = 0;
  let pendingApprovals = 0;
  const activeNow = (): number => Date.now() - pausedMs - (pausedAt === null ? 0 : Date.now() - pausedAt);
  let lastActivity = activeNow();
  try {
    const wrapped: SessionSpec = {
      ...spec,
      onEvent: (event) => {
        lastActivity = activeNow();
        append(`[event] ${JSON.stringify(event)}`);
        spec.onEvent?.(event);
      },
      ...(spec.requestApproval ? {
        requestApproval: async (request, signal) => {
          pendingApprovals += 1;
          if (pendingApprovals === 1) pausedAt = Date.now();
          append(`[approval] waiting ${JSON.stringify({ backend: request.backend, tool: request.tool, kind: request.kind })}`);
          try {
            return await spec.requestApproval!(request, signal);
          } finally {
            pendingApprovals -= 1;
            if (pendingApprovals === 0 && pausedAt !== null) {
              pausedMs += Date.now() - pausedAt;
              pausedAt = null;
              lastActivity = activeNow();
              append('[approval] resumed');
            }
          }
        }
      } : {})
    };
    session = await backend.openSession(wrapped);
    append(`[session] opened on backend ${backend.id}`);
  } catch (error) {
    return failure(`failed to open ${backend.id} session: ${errorMessage(error)}`) as unknown as AgentRunOutcome<T>;
  }

  let timedOut = false;
  let stalled = false;
  let settled = false;
  let graceTimer: NodeJS.Timeout | null = null;

  const requestInterrupt = (): void => {
    append(`[supervisor] interrupt requested (timedOut=${timedOut} stalled=${stalled})`);
    if (!graceTimer) {
      graceTimer = setTimeout(() => {
        append('[supervisor] grace expired, closing transport');
        void session.close().catch(() => {});
      }, TERMINATION_GRACE_MS);
    }
    void session.interrupt().catch(() => {});
  };

  const timerInterval = setInterval(() => {
    if (pendingApprovals > 0) return;
    const now = activeNow();
    if (!timedOut && now - startedAt > spec.timeoutMs) {
      timedOut = true;
      requestInterrupt();
      return;
    }
    if (!stalled && now - lastActivity > spec.staleAfterMs) {
      stalled = true;
      requestInterrupt();
    }
  }, Math.min(1000, Math.max(20, Math.floor(Math.min(spec.timeoutMs, spec.staleAfterMs) / 4))));

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
    clearInterval(timerInterval);
    if (graceTimer) clearTimeout(graceTimer);
    await session.close().catch(() => {});
    append(`[session] closed (settled=${String(settled)})`);
  }

  const merged: AgentRunOutcome = {
    ...outcome,
    timedOut: outcome.timedOut || timedOut,
    stalled: outcome.stalled || stalled
  };
  if (!merged.ok && (timedOut || stalled)) {
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
