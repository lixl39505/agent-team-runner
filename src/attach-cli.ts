/* istanbul ignore file */
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { hostname as nodeHostname } from 'node:os';
import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { AttachRunSelectorUi, AttachRunUi, type AttachRunUiState } from './core/attach-ui.js';
import { loadDaemonBootstrapConfig } from './core/daemon-config.js';
import { resolveAgentTeamHome, type AgentTeamHome } from './core/home.js';
import { LocalIpcClient } from './daemon/ipc.js';

type IpcClient = Pick<LocalIpcClient, 'connect' | 'request' | 'close'>;
type SignalRegister = (signal: NodeJS.Signals, listener: () => void) => void;
type Ask = (prompt: string) => Promise<string>;
type RawInput = Readable & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void; resume(): void };
type TerminalOutput = Writable & { isTTY?: boolean };
type MouseEvent = { button: number; column: number; row: number; released: boolean };

interface AttachUi {
  readonly isInteractive: boolean;
  start(): void;
  update(state: AttachRunUiState): void;
  addEvents(events: unknown[]): void;
  moveAgent?(delta: number): void;
  selectAgentAt?(column: number, row: number): void;
  requestAgentLog?(): string | undefined;
  setAgentLogFollowing?(following: boolean): void;
  showAgentLog?(value: unknown): void;
  showAgentLogFallback?(agentId: string, error: unknown): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface AttachCliDependencies {
  resolveHome?: typeof resolveAgentTeamHome;
  createClient?: (home: AgentTeamHome) => IpcClient;
  createUi?: (runId: string, output: Writable) => AttachUi;
  input?: Readable;
  output?: Writable;
  hostname?: () => string;
  randomUUID?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  ask?: Ask;
  registerSignal?: SignalRegister;
}

export async function runAttachCli(
  args: string[] = process.argv.slice(2),
  deps: AttachCliDependencies = {}
): Promise<void> {
  const { runId: requestedRunId, home } = attachArguments(args, deps.resolveHome ?? resolveAgentTeamHome);
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const client = deps.createClient ? deps.createClient(home) : new LocalIpcClient(home.socket);
  const clientId = (deps.randomUUID ?? nodeRandomUUID)();
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error('attach pollIntervalMs must be a positive integer');

  let runId = requestedRunId;
  let ui: AttachUi | undefined;
  let attached = false;
  let stopped = false;
  let renderedEventId: number | undefined;
  let readline: Interface | undefined;
  let cancelSelection: (() => void) | undefined;
  let removeKeys: (() => void) | undefined;
  let followAgentId: string | undefined;
  const ask: Ask = deps.ask ?? (async (prompt) => {
    if (!readline) readline = createInterface({
      input,
      output,
      terminal: Boolean((input as Readable & { isTTY?: boolean }).isTTY && (output as Writable & { isTTY?: boolean }).isTTY)
    });
    return await readline.question(prompt);
  });
  const stop = (): void => {
    stopped = true;
    cancelSelection?.();
    readline?.close();
  };
  const onEnd = (): void => stop();
  const registerSignal: SignalRegister = deps.registerSignal ?? ((signal, listener) => process.once(signal, listener));
  registerSignal('SIGINT', stop);
  registerSignal('SIGTERM', stop);
  input.once('end', onEnd);
  input.once('error', onEnd);

  try {
    await client.connect();
    if (!runId) {
      const [projects, runs] = await Promise.all([
        client.request('project.list'),
        client.request('execution.list')
      ]);
      runId = await selectRun(projects, runs, input, output, loadDaemonBootstrapConfig(home.root).tui.color, (cancel) => {
        cancelSelection = cancel;
      });
      cancelSelection = undefined;
      if (!runId || stopped) return;
    }
    ui = deps.createUi
      ? deps.createUi(runId, output)
      : new AttachRunUi(runId, output, loadDaemonBootstrapConfig(home.root).tui.color);
    await client.request('controller.attach', {
      runId,
      host: (deps.hostname ?? nodeHostname)(),
      externalThreadId: runId,
      clientId
    });
    attached = true;
    ui.start();
    let answerRequested = false;
    let denyRequested = false;
    let logAgentId: string | undefined;
    removeKeys = attachKeys(input, output, ui, () => { answerRequested = true; }, () => { denyRequested = true; }, () => {
      logAgentId = ui?.requestAgentLog?.();
    }, () => {
      const agentId = ui?.requestAgentLog?.();
      if (!agentId) return;
      followAgentId = followAgentId === agentId ? undefined : agentId;
      ui?.setAgentLogFollowing?.(followAgentId !== undefined);
    }, stop);

    do {
      const response = await client.request('execution.events', eventParams(runId, clientId));
      const events = eventsFrom(response);
      ui.addEvents(events.events);
      // The daemon advances its durable acknowledgement only when this next request includes the rendered cursor.
      if (events.lastEventId !== undefined) renderedEventId = events.lastEventId;
      const [execution, interactions, projects, runs] = await Promise.all([
        client.request('execution.get', { runId }),
        client.request('interaction.list', { runId }),
        client.request('project.list'),
        client.request('execution.list')
      ]);
      ui.update({ ...executionState(execution), interactions, projects, runs });
      if (ui.isInteractive && (logAgentId || followAgentId)) {
        const agentId = logAgentId ?? followAgentId!;
        logAgentId = undefined;
        try {
          ui.showAgentLog?.(await client.request('execution.agent_log', { runId, agentId }));
        } catch (error) {
          ui.showAgentLogFallback?.(agentId, error);
        }
      }
      if (ui.isInteractive && answerRequested) {
        answerRequested = false;
        try {
          await answerQueuedInteraction(interactions, client, clientId, ui, (prompt) => askWithCookedInput(input, ask, prompt));
        } catch (error) {
          if (!stopped) throw error;
        }
      }
      if (ui.isInteractive && denyRequested) {
        denyRequested = false;
        await denyQueuedApproval(interactions, client, clientId);
      }
      if (stopped || !ui.isInteractive) break;
      await sleep(pollIntervalMs);
    } while (!stopped);
  } finally {
    input.off('end', onEnd);
    input.off('error', onEnd);
    removeKeys?.();
    readline?.close();
    ui?.stop();
    if (attached) {
      await client.request('interaction.requeue_client', { clientId }).catch(() => {});
      await client.request('controller.disconnect', { runId, clientId }).catch(() => {});
    }
    client.close();
  }

  function eventParams(currentRunId: string, currentClientId: string): Record<string, unknown> {
    return {
      runId: currentRunId,
      clientId: currentClientId,
      ...(renderedEventId === undefined ? {} : { afterEventId: renderedEventId })
    };
  }
}

export function attachArguments(args: string[], resolveHome: typeof resolveAgentTeamHome): { runId?: string; home: AgentTeamHome } {
  const options = [...args];
  const runId = options[0]?.startsWith('--') ? undefined : options.shift();
  if (options.length === 0) return { ...(runId === undefined ? {} : { runId }), home: resolveHome() };
  if (options[0] !== '--home') throw new Error(`Unknown attach option: ${options[0]}`);
  const homePath = options[1];
  if (!homePath || homePath.startsWith('--')) throw new Error('--home requires a value');
  if (options.length > 2) throw new Error(`Unknown attach option: ${options[2]}`);
  return {
    ...(runId === undefined ? {} : { runId }),
    home: resolveHome({ env: { ...process.env, AGENT_TEAM_HOME: homePath } })
  };
}

async function selectRun(
  projects: unknown,
  runs: unknown,
  input: Readable,
  output: Writable,
  color: ReturnType<typeof loadDaemonBootstrapConfig>['tui']['color'],
  setCancel: (cancel: () => void) => void
): Promise<string | undefined> {
  const selector = new AttachRunSelectorUi(list(projects), list(runs), output, color);
  selector.start();
  const terminal = input as RawInput;
  if (!selector.isInteractive || !terminal.isTTY || !terminal.setRawMode) return undefined;
  return await new Promise<string | undefined>((resolve) => {
    let complete = false;
    const finish = (runId?: string): void => {
      if (complete) return;
      complete = true;
      terminal.off('data', onData);
      disableMouse();
      terminal.setRawMode?.(false);
      selector.stop();
      resolve(runId);
    };
    const onData = (data: Buffer | string): void => {
      const keys = terminalKeys(data.toString());
      if (keys.includes('quit')) return finish();
      if (keys.includes('up')) selector.move(-1);
      if (keys.includes('down')) selector.move(1);
      if (keys.includes('enter')) finish(selector.selectedRunId);
      for (const event of mouse.events(data.toString())) {
        if (event.button === 0 && !event.released) selector.selectAt(event.row);
        if (event.button === 64) selector.move(-1);
        if (event.button === 65) selector.move(1);
      }
    };
    setCancel(() => finish());
    const mouse = terminalMouse(terminal, output);
    const disableMouse = mouse.disable;
    terminal.setRawMode!(true);
    terminal.on('data', onData);
    terminal.resume();
  });
}

function attachKeys(
  input: Readable,
  output: Writable,
  ui: AttachUi,
  answer: () => void,
  deny: () => void,
  log: () => void,
  follow: () => void,
  stop: () => void
): () => void {
  const terminal = input as RawInput;
  if (!ui.isInteractive || !terminal.isTTY || !terminal.setRawMode) return () => {};
  const mouse = terminalMouse(terminal, output);
  const onData = (data: Buffer | string): void => {
    const keys = terminalKeys(data.toString());
    if (keys.includes('quit')) {
      stop();
      return;
    }
    if (keys.includes('up')) ui.moveAgent?.(-1);
    if (keys.includes('down')) ui.moveAgent?.(1);
    if (keys.includes('enter') || keys.includes('answer')) answer();
    if (keys.includes('deny')) deny();
    if (keys.includes('log')) log();
    if (keys.includes('follow')) follow();
    for (const event of mouse.events(data.toString())) {
      if (event.button === 0 && !event.released) ui.selectAgentAt?.(event.column, event.row);
      if (event.button === 64) ui.moveAgent?.(-1);
      if (event.button === 65) ui.moveAgent?.(1);
    }
  };
  terminal.setRawMode(true);
  terminal.on('data', onData);
  terminal.resume();
  return () => {
    terminal.off('data', onData);
    terminal.setRawMode?.(false);
    mouse.disable();
  };
}

async function askWithCookedInput(input: Readable, ask: Ask, prompt: string): Promise<string> {
  const terminal = input as RawInput;
  const restoreRawMode = Boolean(terminal.isTTY && terminal.setRawMode);
  if (restoreRawMode) terminal.setRawMode!(false);
  try {
    return await ask(prompt);
  } finally {
    if (restoreRawMode) terminal.setRawMode!(true);
  }
}

function terminalKeys(value: string): Array<'up' | 'down' | 'enter' | 'answer' | 'deny' | 'log' | 'follow' | 'quit'> {
  if (value.includes('\u0003') || value.toLowerCase().includes('q')) return ['quit'];
  const keys: Array<'up' | 'down' | 'enter' | 'answer' | 'deny' | 'log' | 'follow' | 'quit'> = [];
  if (value.includes('\x1b[A')) keys.push('up');
  if (value.includes('\x1b[B')) keys.push('down');
  if (value.includes('\r') || value.includes('\n')) keys.push('enter');
  if (value.toLowerCase().includes('a')) keys.push('answer');
  if (value.toLowerCase().includes('d')) keys.push('deny');
  if (value.toLowerCase().includes('l')) keys.push('log');
  if (value.toLowerCase().includes('f')) keys.push('follow');
  return keys;
}

function terminalMouse(input: RawInput, output: Writable): { events: (value: string) => MouseEvent[]; disable: () => void } {
  const terminal = process.env.TERM ?? '';
  const supported = Boolean(input.isTTY && input.setRawMode && (output as TerminalOutput).isTTY)
    && /(?:xterm|screen|tmux|rxvt|vt[12]00|kitty|wezterm|alacritty|foot|iterm)/i.test(terminal);
  if (!supported) return { events: () => [], disable: () => {} };
  output.write('\x1b[?1000h\x1b[?1006h');
  return {
    events: (value) => [...value.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)].map((match) => ({
      button: Number(match[1]), column: Number(match[2]), row: Number(match[3]), released: match[4] === 'm'
    })),
    disable: () => output.write('\x1b[?1000l\x1b[?1006l')
  };
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function eventsFrom(value: unknown): { events: unknown[]; lastEventId?: number } {
  const record = object(value);
  const lastEventId = record.lastEventId;
  return {
    events: Array.isArray(record.events) ? record.events : [],
    ...(typeof lastEventId === 'number' && Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? { lastEventId } : {})
  };
}

function executionState(value: unknown): Omit<AttachRunUiState, 'interactions'> {
  const record = object(value);
  return {
    run: record.run ?? null,
    tasks: record.tasks ?? [],
    agentExecutions: record.agentExecutions ?? []
  };
}

async function answerQueuedInteraction(
  value: unknown,
  client: IpcClient,
  clientId: string,
  ui: AttachUi,
  ask: Ask
): Promise<void> {
  const queued = Array.isArray(value) ? value.find((item) => object(item).status === 'queued') : undefined;
  const interaction = object(queued);
  const id = interaction.id;
  if (typeof id !== 'string') return;
  try {
    await client.request('interaction.claim', { id, clientId });
  } catch {
    // Another controller won the claim. The next refresh is authoritative.
    return;
  }
  ui.pause();
  try {
    const response = await interactionResponse(interaction, ask);
    await client.request('interaction.answer', { id, clientId, response });
  } finally {
    ui.resume();
  }
}

async function denyQueuedApproval(value: unknown, client: IpcClient, clientId: string): Promise<void> {
  const queued = Array.isArray(value) ? value.find((item) => {
    const interaction = object(item);
    return interaction.status === 'queued' && interaction.kind === 'approval';
  }) : undefined;
  const id = object(queued).id;
  if (typeof id !== 'string') return;
  try {
    await client.request('interaction.claim', { id, clientId });
    await client.request('interaction.answer', { id, clientId, response: 'deny' });
  } catch {
    // A competing controller can claim it between refresh and this keypress.
  }
}

async function interactionResponse(interaction: Record<string, unknown>, ask: Ask): Promise<unknown> {
  const request = object(interaction.request);
  if (interaction.kind === 'approval') {
    const allowSession = request.allowSession === true;
    return await approvalResponse(request, allowSession, ask);
  }
  if (interaction.kind === 'agent_question') return await questionResponse(request, ask);
  if (interaction.kind === 'contract_block') {
    await ask(`Contract blocked: ${display(request.reason, 'No reason supplied')}\nPress Enter to acknowledge: `);
    return { acknowledged: true };
  }
  await ask('Unknown interaction. Press Enter to acknowledge: ');
  return {};
}

async function approvalResponse(request: Record<string, unknown>, allowSession: boolean, ask: Ask): Promise<'once' | 'session' | 'deny'> {
  const details = display(request.description, display(request.reason, display(request.tool, 'Approval required')));
  while (true) {
    const choice = (await ask(`${details}\n${allowSession ? '[o] once  [s] session  [d] deny: ' : '[o] once  [d] deny: '}`)).trim().toLowerCase();
    if (choice === 'o' || choice === 'once') return 'once';
    if (allowSession && (choice === 's' || choice === 'session' || choice === 'always')) return 'session';
    if (choice === 'd' || choice === 'deny' || choice === 'reject') return 'deny';
  }
}

async function questionResponse(request: Record<string, unknown>, ask: Ask): Promise<Record<string, string[]>> {
  const answers: Record<string, string[]> = {};
  const questions = Array.isArray(request.questions) ? request.questions : [];
  for (const value of questions) {
    const question = object(value);
    const id = question.id;
    if (typeof id !== 'string') continue;
    const options = Array.isArray(question.options) ? question.options.map(object).filter((option) => typeof option.label === 'string') : [];
    const labels = options.map((option) => option.label as string);
    const multiple = question.multiple === true;
    const allowCustom = question.allowCustom === true;
    while (true) {
      const choices = labels.map((label, index) => `${index + 1}. ${label}`).join('\n');
      const suffix = labels.length === 0 ? 'Answer: ' : multiple ? 'Select comma-separated numbers' : 'Select a number';
      const answer = (await ask(`${display(question.question, 'Question')}\n${choices}${choices ? '\n' : ''}${suffix}${allowCustom ? ' or enter custom text' : ''}: `)).trim();
      const selected = selectAnswer(answer, labels, multiple, allowCustom);
      if (selected) {
        answers[id] = selected;
        break;
      }
    }
  }
  return answers;
}

function selectAnswer(answer: string, options: string[], multiple: boolean, allowCustom: boolean): string[] | undefined {
  if (!answer) return undefined;
  if (options.length === 0) return [answer];
  const values = multiple ? answer.split(',').map((value) => value.trim()).filter(Boolean) : [answer];
  const selected: string[] = [];
  for (const value of values) {
    const index = Number(value);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      selected.push(options[index - 1]!);
      continue;
    }
    const matching = options.find((option) => option.toLowerCase() === value.toLowerCase());
    if (matching) {
      selected.push(matching);
      continue;
    }
    if (allowCustom) {
      selected.push(value);
      continue;
    }
    return undefined;
  }
  return selected.length > 0 ? selected : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function display(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : fallback;
}
