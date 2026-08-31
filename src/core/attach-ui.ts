/* istanbul ignore file */
import type { Writable } from 'node:stream';
import type { AgentEvent } from '../agent/types.js';

const MAX_EVENTS = 200;

export interface AttachRunUiState {
  run: unknown;
  tasks: unknown;
  agentExecutions: unknown;
  interactions: unknown;
}

type TerminalOutput = Writable & { isTTY?: boolean; columns?: number; rows?: number };

/** Read-only dashboard for a daemon-owned run. */
export class AttachRunUi {
  private readonly lines: string[] = [];
  private state: AttachRunUiState = { run: null, tasks: [], agentExecutions: [], interactions: [] };
  private active = false;
  private paused = false;
  private plainRendered = false;

  constructor(private readonly runId: string, private readonly output: TerminalOutput = process.stdout) {}

  get isInteractive(): boolean {
    return Boolean(this.output.isTTY && this.output.columns && this.output.rows);
  }

  start(): void {
    if (!this.isInteractive) return;
    this.active = true;
    this.output.write('\x1b[?1049h\x1b[?25l');
    this.render();
  }

  update(state: AttachRunUiState): void {
    this.state = state;
    this.render();
  }

  addEvents(events: unknown[]): void {
    for (const event of events) {
      const line = formatAttachEvent(event);
      if (line) this.lines.push(line);
    }
    if (this.lines.length > MAX_EVENTS) this.lines.splice(0, this.lines.length - MAX_EVENTS);
    if (this.isInteractive) this.render();
  }

  pause = (): void => {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.output.write('\x1b[?1049l\x1b[?25h');
  };

  resume = (): void => {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this.output.write('\x1b[?1049h\x1b[?25l');
    this.render();
  };

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (!this.paused) this.output.write('\x1b[?1049l\x1b[?25h');
  }

  private render(): void {
    if (!this.isInteractive) {
      if (!this.plainRendered) {
        this.plainRendered = true;
        this.output.write(`${this.text()}\n`);
      }
      return;
    }
    if (!this.active || this.paused) return;
    const columns = Math.max(60, this.output.columns ?? 120);
    const rows = Math.max(12, this.output.rows ?? 30);
    const split = Math.max(38, Math.floor(columns * 0.62));
    const rightWidth = columns - split - 3;
    const run = object(this.state.run);
    const tasks = array(this.state.tasks);
    const executions = array(this.state.agentExecutions);
    const interactions = array(this.state.interactions).filter((item) => object(item).status === 'queued');
    const left = this.lines.slice(-(rows - 3)).map((line) => clip(line, split - 1));
    const right = [
      `RUN ${text(run.status, 'unknown')}`,
      `TASKS ${tasks.map((task) => text(object(task).status, 'unknown')).join(', ') || 'none'}`,
      '',
      'AGENTS',
      ...executions.map((entry) => executionText(object(entry), rightWidth)),
      '',
      `PENDING INTERACTIONS ${interactions.length}`,
      ...interactions.map((entry) => clip(`${text(object(entry).kind, 'unknown')} ${text(object(entry).agentId, 'unknown')}`, rightWidth))
    ];
    const contentRows = rows - 2;
    const rendered = Array.from({ length: contentRows }, (_value, index) => {
      const leftLine = left[index] ?? '';
      const rightLine = right[index] ?? '';
      return `${leftLine.padEnd(split)} │ ${rightLine}`;
    });
    this.output.write(`\x1b[H\x1b[2J\x1b[1m${clip(` Agent Team Attach  ${this.runId} `, columns)}\x1b[0m\n${rendered.join('\n')}\n\x1b[2mCtrl-C exits and requeues unanswered interactions.\x1b[0m`);
  }

  private text(): string {
    const run = object(this.state.run);
    const tasks = array(this.state.tasks);
    const executions = array(this.state.agentExecutions);
    const interactions = array(this.state.interactions).filter((item) => object(item).status === 'queued');
    return [
      `Run ${this.runId}: ${text(run.status, 'unknown')}`,
      `Tasks: ${tasks.length}`,
      `Agents: ${executions.map((entry) => executionText(object(entry), 160)).join('; ') || 'none'}`,
      `Pending interactions: ${interactions.length}`,
      ...this.lines
    ].join('\n');
  }
}

/** Safely formats the durable AGENT_EVENT payload without treating it as trusted input. */
export function formatAttachEvent(value: unknown): string | null {
  const record = object(value);
  if (text(record.eventType) !== 'AGENT_EVENT') return null;
  const payload = object(record.payload);
  const execution = object(payload.execution);
  const event = agentEvent(payload.event);
  if (!event) return `[${text(execution.agentId, 'unknown')}] invalid AGENT_EVENT`;
  const formatted = formatEvent(event);
  return formatted ? `[${text(execution.agentId, 'unknown')}] ${formatted}` : null;
}

function agentEvent(value: unknown): AgentEvent | undefined {
  const event = object(value);
  const type = text(event.type);
  if (type === 'activity') return { type };
  if (type === 'session' && typeof event.sessionId === 'string') return { type, sessionId: event.sessionId };
  if (type === 'message' && typeof event.text === 'string') return { type, text: event.text };
  if (type === 'tool-call' && typeof event.tool === 'string') return { type, tool: event.tool, input: event.input };
  if (type === 'tool-result' && typeof event.tool === 'string' && typeof event.ok === 'boolean') {
    return typeof event.summary === 'string'
      ? { type, tool: event.tool, ok: event.ok, summary: event.summary }
      : { type, tool: event.tool, ok: event.ok };
  }
  if (type === 'permission-check' && typeof event.tool === 'string' && typeof event.ok !== 'boolean' && typeof event.allowed === 'boolean') {
    return typeof event.reason === 'string'
      ? { type, tool: event.tool, input: event.input, allowed: event.allowed, reason: event.reason }
      : { type, tool: event.tool, input: event.input, allowed: event.allowed };
  }
  if (type === 'usage') {
    return {
      type,
      ...(typeof event.inputTokens === 'number' ? { inputTokens: event.inputTokens } : {}),
      ...(typeof event.outputTokens === 'number' ? { outputTokens: event.outputTokens } : {})
    };
  }
  return undefined;
}

function executionText(entry: Record<string, unknown>, width: number): string {
  const task = text(entry.taskId);
  const model = text(entry.model);
  return clip(`${text(entry.agentId, 'unknown')} ${text(entry.role, 'unknown')}${task ? `/${task}` : ''} ${text(entry.backend, 'unknown')}${model ? `/${model}` : ''} ${text(entry.status, 'unknown')}`, width);
}

function formatEvent(event: AgentEvent): string | null {
  if (event.type === 'activity') return null;
  if (event.type === 'session') return `session ${event.sessionId}`;
  if (event.type === 'message') return event.text.replace(/\s+/g, ' ').trim();
  if (event.type === 'tool-call') return `> ${event.tool} ${clip(stringify(event.input), 160)}`;
  if (event.type === 'tool-result') return `< ${event.tool}: ${event.ok ? 'ok' : 'failed'}${event.summary ? ` ${event.summary.replace(/\s+/g, ' ')}` : ''}`;
  if (event.type === 'permission-check') return `permission ${event.tool}: ${event.allowed ? 'allowed' : 'denied'}${event.reason ? ` (${event.reason})` : ''}`;
  return `usage in=${event.inputTokens ?? 0} out=${event.outputTokens ?? 0}`;
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : fallback;
}

function clip(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 3))}...`;
}
