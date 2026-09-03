import { basename, join, dirname } from 'node:path';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  /** question 明细(id + 问题文本),供外层通过契约修订(implementationGuidance)作答。 */
  questions?: Array<{ id: string; question: string }>;
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
    // 读取失败（缺失或损坏）：把损坏文件移到 .corrupt 备份，避免覆盖丢失证据。
    quarantine(path);
    return undefined;
  }
  if (!isValidPendingFile(parsed)) {
    quarantine(path);
    return undefined;
  }
  return parsed as PendingFile;
}

function isValidPendingFile(value: unknown): value is PendingFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as { runId?: unknown; pending?: unknown };
  return typeof file.runId === 'string' && Array.isArray(file.pending);
}

/** 原子写：先写同目录临时文件，再 rename 覆盖，中断不会留下半截 JSON。 */
export function writePendingFileSync(path: string, file: PendingFile): void {
  writeJsonAtomically(path, file);
}

export function writeBlockersFileSync(path: string, blockers: readonly ContractBlocker[]): void {
  writeJsonAtomically(path, { blockers });
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`);
  } catch {
    // 没有可隔离的文件（例如原本就不存在）时忽略。
  }
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

