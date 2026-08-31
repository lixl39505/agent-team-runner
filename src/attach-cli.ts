/* istanbul ignore file */
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { hostname as nodeHostname } from 'node:os';
import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { AttachRunUi, type AttachRunUiState } from './core/attach-ui.js';
import { resolveAgentTeamHome, type AgentTeamHome } from './core/home.js';
import { LocalIpcClient } from './daemon/ipc.js';

type IpcClient = Pick<LocalIpcClient, 'connect' | 'request' | 'close'>;
type SignalRegister = (signal: NodeJS.Signals, listener: () => void) => void;
type Ask = (prompt: string) => Promise<string>;

interface AttachUi {
  readonly isInteractive: boolean;
  start(): void;
  update(state: AttachRunUiState): void;
  addEvents(events: unknown[]): void;
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
  const { runId, home } = attachArguments(args, deps.resolveHome ?? resolveAgentTeamHome);
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const client = deps.createClient ? deps.createClient(home) : new LocalIpcClient(home.socket);
  const clientId = (deps.randomUUID ?? nodeRandomUUID)();
  const ui = deps.createUi ? deps.createUi(runId, output) : new AttachRunUi(runId, output);
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error('attach pollIntervalMs must be a positive integer');

  let attached = false;
  let stopped = false;
  let renderedEventId: number | undefined;
  let readline: Interface | undefined;
  const ask: Ask = deps.ask ?? (async (prompt) => {
    if (!readline) readline = createInterface({
      input,
      output,
      terminal: Boolean((input as Readable & { isTTY?: boolean }).isTTY && (output as Writable & { isTTY?: boolean }).isTTY)
    });
    return await readline.question(prompt);
  });
  const stop = (): void => { stopped = true; readline?.close(); };
  const onEnd = (): void => stop();
  const registerSignal: SignalRegister = deps.registerSignal ?? ((signal, listener) => process.once(signal, listener));
  registerSignal('SIGINT', stop);
  registerSignal('SIGTERM', stop);
  input.once('end', onEnd);
  input.once('error', onEnd);

  try {
    await client.connect();
    await client.request('controller.attach', {
      runId,
      host: (deps.hostname ?? nodeHostname)(),
      externalThreadId: runId,
      clientId
    });
    attached = true;
    ui.start();

    do {
      const response = await client.request('execution.events', eventParams(runId, clientId));
      const events = eventsFrom(response);
      ui.addEvents(events.events);
      // The daemon advances its durable acknowledgement only when this next request includes the rendered cursor.
      if (events.lastEventId !== undefined) renderedEventId = events.lastEventId;
      const execution = await client.request('execution.get', { runId });
      const interactions = await client.request('interaction.list', { runId });
      ui.update({ ...executionState(execution), interactions });
      if (ui.isInteractive) {
        try {
          await answerQueuedInteraction(interactions, client, clientId, ui, ask);
        } catch (error) {
          if (!stopped) throw error;
        }
      }
      if (stopped || !ui.isInteractive) break;
      await sleep(pollIntervalMs);
    } while (!stopped);
  } finally {
    input.off('end', onEnd);
    input.off('error', onEnd);
    readline?.close();
    ui.stop();
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

function attachArguments(args: string[], resolveHome: typeof resolveAgentTeamHome): { runId: string; home: AgentTeamHome } {
  const [runId, ...options] = args;
  if (!runId || runId.startsWith('--')) throw new Error('Usage: agent-team attach <run-id> [--home PATH]');
  if (options.length === 0) return { runId, home: resolveHome() };
  if (options[0] !== '--home') throw new Error(`Unknown attach option: ${options[0]}`);
  const homePath = options[1];
  if (!homePath || homePath.startsWith('--')) throw new Error('--home requires a value');
  if (options.length > 2) throw new Error(`Unknown attach option: ${options[2]}`);
  return { runId, home: resolveHome({ env: { ...process.env, AGENT_TEAM_HOME: homePath } }) };
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
