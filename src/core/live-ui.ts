import type { Writable } from 'node:stream';
import type { AgentEvent } from '../agent/types.js';
import type { StateDatabase } from './db.js';
import type { AgentExecutionInfo } from './agent-execution.js';

const MAX_EVENTS = 200;

/** Minimal ANSI dashboard. It deliberately has no keyboard handling, so readline keeps ownership of stdin. */
export class LiveRunUi {
  private readonly lines: string[] = [];
  private runId: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private active = false;
  private paused = false;

  constructor(private readonly db: StateDatabase, private readonly output: Writable = process.stdout) {}

  start(runId?: string): void {
    this.runId = runId;
    const terminal = this.output as Writable & { isTTY?: boolean; columns?: number; rows?: number };
    // Embedded callers and test doubles may report isTTY without supporting ANSI dimensions.
    if (!terminal.isTTY || !terminal.columns || !terminal.rows) return;
    this.active = true;
    this.output.write('\x1b[?1049h\x1b[?25l');
    this.timer = setInterval(() => this.render(), 500);
    this.render();
  }

  setRun(runId: string): void {
    this.runId = runId;
    this.render();
  }

  onEvent = (execution: AgentExecutionInfo, event: AgentEvent): void => {
    if (!this.runId) this.runId = execution.runId;
    const text = formatEvent(event);
    if (text) {
      this.lines.push(`[${execution.agentId}] ${text}`);
      if (this.lines.length > MAX_EVENTS) this.lines.splice(0, this.lines.length - MAX_EVENTS);
    }
    this.render();
  };

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
    clearInterval(this.timer!);
    this.timer = undefined;
    this.active = false;
    if (!this.paused) this.output.write('\x1b[?1049l\x1b[?25h');
  }

  private render(): void {
    if (!this.active || this.paused) return;
    const columns = Math.max(60, (this.output as Writable & { columns?: number }).columns ?? 120);
    const rows = Math.max(12, (this.output as Writable & { rows?: number }).rows ?? 30);
    const split = Math.max(38, Math.floor(columns * 0.64));
    const rightWidth = columns - split - 3;
    const executions = this.runId && typeof this.db.listAgentExecutions === 'function'
      ? this.db.listAgentExecutions(this.runId)
      : [];
    const left = this.lines.slice(-(rows - 3)).map((line) => clip(line, split - 1));
    const right = [
      'AGENTS',
      ...executions.map((entry) => clip(`${entry.agentId} ${entry.role}${entry.taskId ? `/${entry.taskId}` : ''} ${entry.backend}${entry.model ? `/${entry.model}` : ''} ${entry.status}`, rightWidth)),
      '',
      'agent-team logs <run> --list',
      'agent-team logs <run> <agent> --follow'
    ];
    const contentRows = rows - 2;
    const rendered = Array.from({ length: contentRows }, (_value, index) => {
      const leftLine = left[index] ?? '';
      const rightLine = right[index] ?? '';
      return `${leftLine.padEnd(split)} │ ${rightLine}`;
    });
    const title = ` Agent Team Runner${this.runId ? `  ${this.runId}` : ''} `;
    this.output.write(`\x1b[H\x1b[2J\x1b[1m${clip(title, columns)}\x1b[0m\n${rendered.join('\n')}\n\x1b[2mCtrl-C interrupts; approval prompts temporarily leave this dashboard.\x1b[0m`);
  }
}

export function formatEvent(event: AgentEvent): string | null {
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

function clip(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 3))}...`;
}
