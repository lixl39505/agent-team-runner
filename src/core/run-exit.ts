import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { RunRecord, TaskRecord } from './types.js';

export type RunExitKind = 'done' | 'needs_approval' | 'contract_blocked' | 'failed' | 'interrupted';

export interface PendingItem {
  id: string;
  kind: 'approval' | 'question';
  taskId: string | null;
  agentId: string;
  /** 外层批准/拒绝的对象:审批为工具/命令描述,提问为问题列表。 */
  subject: string;
  reason: string;
  /** 审批对应的原始命令;grant approve 时按原样沉淀进项目 allowlist。 */
  commands?: string[];
}

export interface PendingFile {
  runId: string;
  pending: PendingItem[];
}

export interface GrantDecisions {
  [pendingId: string]: 'approve' | 'deny';
}

export interface ContractBlocker {
  taskId: string;
  title: string;
  attempts: number;
  reason: string;
}

export interface RunExitClassification {
  code: number;
  kind: RunExitKind;
}

export function classifyRunExit(input: {
  run: RunRecord;
  tasks: readonly TaskRecord[];
  pending: readonly PendingItem[];
  interrupted: boolean;
}): RunExitClassification {
  if (input.interrupted) return { code: 130, kind: 'interrupted' };
  if (input.run.status === 'done') return { code: 0, kind: 'done' };
  if (input.tasks.some((task) => task.status === 'blocked_on_contract')) return { code: 11, kind: 'contract_blocked' };
  if (input.pending.length > 0) return { code: 10, kind: 'needs_approval' };
  return { code: 1, kind: 'failed' };
}

export function contractBlockers(tasks: readonly TaskRecord[]): ContractBlocker[] {
  return tasks
    .filter((task) => task.status === 'blocked_on_contract')
    .map((task) => ({
      taskId: task.taskId,
      title: task.title,
      attempts: task.attempts,
      reason: task.lastError ?? 'Worker requested a contract revision without a reason.'
    }));
}

export function readPendingFileSync(path: string): PendingFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const file = parsed as { runId?: unknown; pending?: unknown };
  if (typeof file.runId !== 'string' || !Array.isArray(file.pending)) return undefined;
  return file as PendingFile;
}

export function writePendingFileSync(path: string, file: PendingFile): void {
  writeJsonFileSync(path, file);
}

export function writeBlockersFileSync(path: string, blockers: readonly ContractBlocker[]): void {
  writeJsonFileSync(path, { blockers });
}

export function renderRunSummary(input: {
  runId: string;
  kind: RunExitKind;
  code: number;
  status: string;
  integrationBranch: string | null;
  integrationCommit: string | null;
  contractRevision: number;
  tasks: readonly TaskRecord[];
  pending: readonly PendingItem[];
  blockers: readonly ContractBlocker[];
  pendingPath: string;
  handoffPath?: string | undefined;
}): string {
  const lines = [
    `Run ${input.runId}: ${input.kind} (exit ${input.code})`,
    `- Run status: ${input.status}`,
    `- Contract revision: ${input.contractRevision}`,
    `- Integration branch: ${input.integrationBranch ?? 'none'}`,
    `- Integration commit: ${input.integrationCommit ?? 'none'}`,
    `- Tasks: ${input.tasks.map((task) => `${task.taskId}:${task.status}`).join(', ') || 'none'}`,
    `- Pending approvals: ${input.pending.length} (${input.pendingPath})`
  ];
  if (input.blockers.length > 0) lines.push(`- Contract blockers: ${input.blockers.map((blocker) => blocker.taskId).join(', ')}`);
  if (input.handoffPath) lines.push(`- Handoff: ${input.handoffPath}`);
  return lines.join('\n');
}

export function renderMachineSummary(input: {
  runId: string;
  kind: RunExitKind;
  code: number;
  status: string;
  contractRevision: number;
  pendingCount: number;
  blockers: readonly ContractBlocker[];
}): string {
  return JSON.stringify({
    runId: input.runId,
    kind: input.kind,
    exit: input.code,
    status: input.status,
    contractRevision: input.contractRevision,
    pending: input.pendingCount,
    contractBlockedTaskIds: input.blockers.map((blocker) => blocker.taskId)
  });
}

export function pendingItemPath(runsDir: string, runId: string): string {
  return join(runsDir, runId, 'pending.json');
}

export function blockersPath(runsDir: string, runId: string): string {
  return join(runsDir, runId, 'blockers.json');
}

export function handoffPath(runsDir: string, runId: string): string {
  return join(runsDir, runId, 'handoff.json');
}

function writeJsonFileSync(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
