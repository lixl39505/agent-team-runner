import { spawn } from 'node:child_process';
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
type Attention = (kind: 'approval' | 'question') => void;
type Notify = (title: string, message: string) => void;
export interface TerminalAlertColors {
  background: string;
  foreground: string;
}

const DEFAULT_ALERT_COLORS: TerminalAlertColors = {
  background: '#7C3AED',
  foreground: '#FFFFFF'
};

/** Serializes concurrent backend requests so only one prompt owns stdin at a time. */
export class ApprovalQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ask: Ask,
    private readonly write: (text: string) => void,
    private readonly attention?: Attention
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
    this.attention?.('approval');
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
    this.attention?.('question');
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

  constructor(
    input: Readable = process.stdin,
    output: Writable = process.stdout,
    colors: TerminalAlertColors = DEFAULT_ALERT_COLORS,
    notify: Notify = sendSystemNotification
  ) {
    this.readline = createInterface({ input, output, terminal: true });
    const queue = new ApprovalQueue(
      async (prompt, signal) => signal
        ? await this.readline.question(prompt, { signal })
        : await this.readline.question(prompt),
      (text) => output.write(text),
      (kind) => {
        if (!(output as Writable & { isTTY?: boolean }).isTTY) return;
        const label = kind === 'approval' ? 'Approval required' : 'Answer required';
        const message = 'Agent Team Runner needs your input.';
        output.write(`\n${alertStyle(colors)} ${label}: human input needed \x1b[0m\n`);
        notify('Agent Team Runner', `${label}. ${message}`);
      }
    );
    this.request = queue.request;
    this.requestUserInput = queue.requestUserInput;
  }

  close(): void {
    this.readline.close();
  }
}

function alertStyle(colors: TerminalAlertColors): string {
  const foreground = hexToRgb(colors.foreground);
  const background = hexToRgb(colors.background);
  return `\x1b[1;38;2;${foreground.join(';')};48;2;${background.join(';')}m`;
}

function hexToRgb(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16)
  ];
}

function sendSystemNotification(title: string, message: string): void {
  if (process.platform === 'darwin') {
    const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" sound name "Glass"`;
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
    return;
  }
  // OSC 9 is a widely supported terminal desktop-notification escape sequence.
  process.stdout.write(`\x1b]9;${message}\x07`);
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
