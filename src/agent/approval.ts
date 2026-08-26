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

export interface UserInputOption {
  label: string;
  description?: string | undefined;
}

export interface UserInputQuestion {
  id: string;
  header?: string | undefined;
  question: string;
  options?: UserInputOption[] | undefined;
  multiple?: boolean | undefined;
  allowCustom?: boolean | undefined;
  secret?: boolean | undefined;
}

export interface UserInputRequest {
  backend: BackendId;
  role: AgentRole;
  label?: string | undefined;
  sessionId?: string | undefined;
  cwd: string;
  questions: UserInputQuestion[];
}

export type UserInputAnswers = Record<string, string[]>;
export type UserInputHandler = (request: UserInputRequest, signal?: AbortSignal) => Promise<UserInputAnswers>;

type Ask = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** Serializes concurrent backend requests so only one prompt owns stdin at a time. */
export class ApprovalQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ask: Ask,
    private readonly write: (text: string) => void
  ) {}

  request: ApprovalHandler = async (request, signal) => {
    return await this.enqueue(() => this.promptApproval(request, signal), signal);
  };

  requestUserInput: UserInputHandler = async (request, signal) => {
    return await this.enqueue(() => this.promptUserInput(request, signal), signal);
  };

  private async enqueue<T>(prompt: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const turn = this.tail.then(async () => {
      if (signal?.aborted) throw signal.reason ?? new Error('interaction cancelled');
      return await prompt();
    });
    this.tail = turn.then(() => {}, () => {});
    return await abortable(turn, signal);
  }

  private async promptApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
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

  private async promptUserInput(request: UserInputRequest, signal?: AbortSignal): Promise<UserInputAnswers> {
    this.write(formatUserInputHeading(request));
    const answers: UserInputAnswers = {};
    for (const question of request.questions) {
      this.write(`\n${question.header ? `[${question.header}] ` : ''}${question.question}\n`);
      for (const [index, option] of (question.options ?? []).entries()) {
        this.write(`  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ''}\n`);
      }
      if (question.secret) this.write('  Note: this terminal input is not masked.\n');
      answers[question.id] = await this.promptQuestion(question, signal);
    }
    return answers;
  }

  private async promptQuestion(question: UserInputQuestion, signal?: AbortSignal): Promise<string[]> {
    const options = question.options ?? [];
    const prompt = options.length === 0
      ? 'Answer: '
      : question.multiple
        ? `Select comma-separated numbers${question.allowCustom ? ' or enter custom text' : ''}: `
        : `Select a number${question.allowCustom ? ' or enter custom text' : ''}: `;
    while (true) {
      const answer = (await this.ask(prompt, signal)).trim();
      if (!answer) {
        this.write('Enter an answer.\n');
        continue;
      }
      if (options.length === 0) return [answer];
      const values = question.multiple ? answer.split(',').map((value) => value.trim()).filter(Boolean) : [answer];
      const selected: string[] = [];
      let valid = true;
      for (const value of values) {
        const index = Number(value);
        if (Number.isInteger(index) && index >= 1 && index <= options.length) {
          selected.push(options[index - 1]!.label);
          continue;
        }
        const option = options.find((candidate) => candidate.label.toLowerCase() === value.toLowerCase());
        if (option) {
          selected.push(option.label);
          continue;
        }
        if (question.allowCustom) {
          selected.push(value);
          continue;
        }
        valid = false;
        break;
      }
      if (valid && selected.length > 0) return selected;
      this.write(`Enter ${question.multiple ? 'one or more valid numbers separated by commas' : 'a valid option number'}.\n`);
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
  readonly requestUserInput: UserInputHandler;
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
    this.requestUserInput = queue.requestUserInput;
  }

  close(): void {
    this.readline.close();
  }
}

function formatUserInputHeading(request: UserInputRequest): string {
  const heading = [request.backend, request.role, request.label].filter(Boolean).join(' / ');
  return `\n[Question] ${heading}\nWorking directory: ${request.cwd}\n`;
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
