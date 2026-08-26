import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { AgentRole, BackendId } from '../core/types.js';

export type ApprovalDecision = 'once' | 'session' | 'deny';

export interface ApprovalRequest {
  backend: BackendId;
  role: AgentRole;
  label?: string | undefined;
  sessionId?: string | undefined;
  cwd: string;
  kind: 'command' | 'file-change' | 'network' | 'external-directory' | 'tool';
  tool: string;
  input: unknown;
  title?: string | undefined;
  description?: string | undefined;
  reason?: string | undefined;
  allowSession: boolean;
}

export type ApprovalHandler = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;

type Ask = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** Serializes concurrent backend requests so only one prompt owns stdin at a time. */
export class ApprovalQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ask: Ask,
    private readonly write: (text: string) => void
  ) {}

  request: ApprovalHandler = async (request, signal) => {
    const turn = this.tail.then(async () => {
      if (signal?.aborted) throw signal.reason ?? new Error('approval cancelled');
      return await this.prompt(request, signal);
    });
    this.tail = turn.then(() => {}, () => {});
    return await abortable(turn, signal);
  };

  private async prompt(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    this.write(formatApproval(request));
    while (true) {
      const choices = request.allowSession ? '[o] once  [s] session  [d] deny: ' : '[o] once  [d] deny: ';
      const answer = (await this.ask(choices, signal)).trim().toLowerCase();
      if (answer === 'o' || answer === 'once') return 'once';
      if (request.allowSession && (answer === 's' || answer === 'session' || answer === 'always')) return 'session';
      if (answer === 'd' || answer === 'deny' || answer === 'reject') return 'deny';
      this.write('Enter o, d, or s when session approval is available.\n');
    }
  }
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw signal.reason ?? new Error('approval cancelled');
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(signal.reason ?? new Error('approval cancelled'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class TerminalApprovalBroker {
  readonly request: ApprovalHandler;
  private readonly readline: Interface;

  constructor(input: Readable = process.stdin, output: Writable = process.stdout) {
    this.readline = createInterface({ input, output, terminal: true });
    const queue = new ApprovalQueue(
      async (prompt, signal) => signal
        ? await this.readline.question(prompt, { signal })
        : await this.readline.question(prompt),
      (text) => output.write(text)
    );
    this.request = queue.request;
  }

  close(): void {
    this.readline.close();
  }
}

function formatApproval(request: ApprovalRequest): string {
  const heading = [request.backend, request.role, request.label].filter(Boolean).join(' / ');
  const title = request.title ?? `${request.tool} requests ${request.kind} permission`;
  const details = request.description ?? formatInput(request.input);
  return [
    '',
    `[Approval] ${heading}`,
    title,
    request.reason ? `Reason: ${request.reason}` : '',
    `Working directory: ${request.cwd}`,
    details ? `\n${details}` : '',
    ''
  ].filter((line) => line !== '').join('\n') + '\n';
}

function formatInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    const json = JSON.stringify(input, null, 2);
    return json.length > 4000 ? `${json.slice(0, 4000)}\n...` : json;
  } catch {
    return String(input);
  }
}
