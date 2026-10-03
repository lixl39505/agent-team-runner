// Identifier helpers. Herdr resource ids are NEVER generated here — only
// ids ATeam owns (runs, executions, agent names it will request).

import type { ExecutionRole } from '../core/types.ts';

export function nowIso(): string {
  return new Date().toISOString();
}

/** r-<yyyymmdd>-<6hex> */
export function newRunId(now = new Date()): string {
  const ymd = [
    now.getUTCFullYear().toString().padStart(4, '0'),
    (now.getUTCMonth() + 1).toString().padStart(2, '0'),
    now.getUTCDate().toString().padStart(2, '0'),
  ].join('');
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, 6);
  return `r-${ymd}-${hex}`;
}

export function shortRunId(runId: string): string {
  return runId.slice(-6);
}

/** <runId>-<taskId>-<role[0]>-a<attempt>c<cycle> */
export function newExecutionId(
  runId: string,
  taskId: string,
  role: ExecutionRole,
  attemptNo: number,
  cycleNo: number,
): string {
  return `${runId}-${taskId}-${role[0]}-a${attemptNo}c${cycleNo}`;
}

export function taskBranch(runId: string, taskId: string): string {
  return `ateam/${runId}/task/${taskId}`;
}

export function integrationBranch(runId: string): string {
  return `ateam/${runId}/integration`;
}

/** Herdr agent names must match [a-z][a-z0-9_-]{0,31} and be unique. */
export function agentName(runId: string, taskId: string, role: ExecutionRole, seq: number): string {
  const roleTag = role[0]! + String(seq);
  const budget = 32 - ('at-' + '-').length - shortRunId(runId).length - roleTag.length - 2;
  const taskSlug = taskId.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, Math.max(1, budget));
  return `at-${shortRunId(runId)}-${taskSlug}-${roleTag}`.slice(0, 32);
}
