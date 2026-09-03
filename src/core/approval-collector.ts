import type { ApprovalHandler, UserInputHandler } from '../agent/approval.js';
import { readPendingFileSync, writePendingFileSync, type PendingFile, type PendingItem } from './run-exit.js';
import { isSafeAllowlistedCommand } from './shell.js';

export type RunExitMode = 'eager' | 'quiescence';

export interface ApprovalCollectorOptions {
  runId: string;
  pendingPath: string;
  debounceMs: number;
  exitMode: RunExitMode;
  /** 当前项目 allowlist；命中的命令直接放行（grant 沉淀后重放即由此通过）。 */
  allowedPrefixes: readonly string[];
  /** Called when the eager debounce window elapses while pending items exist. */
  onEagerAbort: () => void;
}

/** Worker-visible guidance attached to every headless denial. */
export const denialGuidance = [
  'Not approved: this request is outside the declared verification allowlist.',
  'Prefer a mechanically equivalent alternative that stays inside the declared commands and allowed paths.',
  'If no equivalent alternative exists and the request would change what the task delivers, end with status "blocked" and list every required non-allowlisted operation in one place.',
  'Never work around a denied request by changing the deliverable; that requires a contract revision instead.'
].join(' ');

/**
 * Headless approval route: deny immediately (the worker adapts or enumerates),
 * record a durable pending item, and drive the eager debounce abort.
 */
export class ApprovalCollector {
  readonly pending: PendingItem[];
  private sequence: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ApprovalCollectorOptions) {
    const existing = readPendingFileSync(options.pendingPath);
    this.pending = existing?.runId === options.runId ? [...existing.pending] : [];
    this.sequence = this.pending.reduce((max, item) => {
      const match = /^p(\d+)$/.exec(item.id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  requestApproval: ApprovalHandler = async (request) => {
    const commands = extractCommands(request.input);
    // grant 沉淀过的命令已进入项目 allowlist：重放时直接放行，避免 approve 后仍无限 exit 10。
    // 沿用验证命令的同一安全边界：命中前缀但携带危险参数（git status --ext-diff 等）
    // 不允许凭前缀放行，必须重新走审批。
    if (commands.length > 0 && commands.every((command) => isSafeAllowlistedCommand(command, this.options.allowedPrefixes))) {
      return 'once';
    }
    this.record({
      kind: 'approval',
      taskId: request.taskId ?? null,
      agentId: `${request.role}:${request.backend}`,
      subject: `${request.kind} ${request.tool}: ${describeInput(request.input)}`,
      reason: request.reason ?? denialGuidance,
      commands
    });
    return 'deny';
  };

  requestUserInput: UserInputHandler = async (request) => {
    this.record({
      kind: 'question',
      taskId: request.taskId ?? null,
      agentId: `${request.role}:${request.backend}`,
      subject: request.questions.map((question) => question.question).join(' | '),
      reason: 'Outer interaction is unavailable in headless mode; proceed from the contract guidance.',
      questions: request.questions.map((question) => ({ id: question.id, question: question.question }))
    });
    return {};
  };

  flush(): void {
    this.stopTimer();
    writePendingFileSync(this.options.pendingPath, this.pendingFile());
  }

  dispose(): void {
    this.stopTimer();
  }

  private pendingFile(): PendingFile {
    return { runId: this.options.runId, pending: this.pending };
  }

  private record(item: Omit<PendingItem, 'id'>): void {
    this.sequence += 1;
    this.pending.push({ id: `p${this.sequence}`, ...item });
    writePendingFileSync(this.options.pendingPath, this.pendingFile());
    if (this.options.exitMode === 'eager') this.restartDebounce();
  }

  private restartDebounce(): void {
    this.stopTimer();
    if (this.options.debounceMs <= 0) {
      this.options.onEagerAbort();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.options.onEagerAbort();
    }, this.options.debounceMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** Applies grant decisions: approved approvals sediment into the project allowlist (done by the caller), denied ones fail their task. */
export function partitionGrants(
  pending: readonly PendingItem[],
  decisions: GrantDecisionMap
): { approved: PendingItem[]; denied: PendingItem[]; unresolved: PendingItem[] } {
  const approved: PendingItem[] = [];
  const denied: PendingItem[] = [];
  const unresolved: PendingItem[] = [];
  for (const item of pending) {
    const decision = decisions[item.id];
    if (decision === 'approve') approved.push(item);
    else if (decision === 'deny') denied.push(item);
    else unresolved.push(item);
  }
  return { approved, denied, unresolved };
}

export interface GrantDecisionMap {
  [pendingId: string]: 'approve' | 'deny';
}

function describeInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? 'unknown input';
  } catch {
    return 'unknown input';
  }
}

/** Extracts verbatim command strings from backend-specific tool input shapes. */
export function extractCommands(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) return input.flatMap(extractCommands);
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const commands: string[] = [];
    for (const key of ['command', 'cmd', 'script']) {
      const value = record[key];
      if (typeof value === 'string') commands.push(value);
      else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
        commands.push((value as string[]).join(' '));
      }
    }
    return [...new Set(commands)];
  }
  return [];
}
