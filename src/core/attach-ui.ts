/* istanbul ignore file */
import type { Writable } from 'node:stream';
import type { AgentEvent } from '../agent/types.js';
import type { TuiColorPreference } from './daemon-config.js';

const MAX_EVENTS = 200;

export interface AttachRunUiState {
  run: unknown;
  tasks: unknown;
  agentExecutions: unknown;
  interactions: unknown;
  projects?: unknown;
  runs?: unknown;
}

type TerminalOutput = Writable & { isTTY?: boolean; columns?: number; rows?: number };

/** Read-only dashboard for a daemon-owned run. */
export class AttachRunUi {
  private readonly lines: string[] = [];
  private state: AttachRunUiState = { run: null, tasks: [], agentExecutions: [], interactions: [] };
  private active = false;
  private paused = false;
  private plainRendered = false;
  private selectedAgent = 0;
  private agentLog: { agentId: string; lines: string[]; fallback: boolean; following: boolean } | undefined;

  constructor(
    private readonly runId: string,
    private readonly output: TerminalOutput = process.stdout,
    private readonly color: TuiColorPreference = 'auto'
  ) {}

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

  moveAgent(delta: number): void {
    const executions = array(this.state.agentExecutions);
    if (executions.length === 0) return;
    this.selectedAgent = (this.selectedAgent + delta + executions.length) % executions.length;
    this.render();
  }

  selectAgentAt(column: number, row: number): void {
    const columns = Math.max(60, this.output.columns ?? 120);
    const projectWidth = Math.max(22, Math.floor((columns - 6) * 0.28));
    const eventWidth = Math.max(28, Math.floor((columns - 6) * 0.43));
    const index = row - 4;
    if (column < projectWidth + eventWidth + 7 || index < 0 || index >= array(this.state.agentExecutions).length) return;
    this.selectedAgent = index;
    this.render();
  }

  requestAgentLog(): string | undefined {
    const selected = object(array(this.state.agentExecutions)[this.selectedAgent]);
    const agentId = text(selected.agentId);
    if (!agentId) return undefined;
    this.agentLog = { agentId, lines: ['Loading tail...'], fallback: false, following: false };
    this.render();
    return agentId;
  }

  showAgentLog(value: unknown): void {
    const result = object(value);
    const agentId = text(result.agentId);
    if (!agentId) return;
    const content = typeof result.content === 'string' ? result.content : '';
    this.agentLog = {
      agentId,
      lines: content ? content.split('\n').map((line) => text(line)) : ['Log is empty.'],
      fallback: false,
      following: this.agentLog?.agentId === agentId && this.agentLog.following
    };
    this.render();
  }

  showAgentLogFallback(agentId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const eventLines = this.lines.filter((line) => line.startsWith(`[${agentId}]`)).slice(-20);
    this.agentLog = {
      agentId,
      lines: [text(message, 'Agent log is unavailable.'), 'Durable event fallback:', ...(eventLines.length > 0 ? eventLines : ['No agent events recorded.'])],
      fallback: true,
      following: false
    };
    this.render();
  }

  setAgentLogFollowing(following: boolean): void {
    if (!this.agentLog) return;
    this.agentLog.following = following;
    this.render();
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
    const projectWidth = Math.max(22, Math.floor((columns - 6) * 0.28));
    const eventWidth = Math.max(28, Math.floor((columns - 6) * 0.43));
    const agentWidth = columns - projectWidth - eventWidth - 6;
    const run = object(this.state.run);
    const executions = array(this.state.agentExecutions);
    const interactions = array(this.state.interactions).filter((item) => object(item).status === 'queued');
    const currentRunId = text(run.id, this.runId);
    const projectPane = projectRunLines(array(this.state.projects), array(this.state.runs), currentRunId, projectWidth);
    const eventRows = Math.max(2, Math.floor((rows - 5) * 0.62));
    const eventPane = [
      'EVENTS',
      ...this.lines.slice(-eventRows).map((line) => clip(line, eventWidth)),
      '',
      `INBOX ${interactions.length}`,
      ...interactions.map((entry) => interactionText(object(entry), eventWidth))
    ];
    if (this.selectedAgent >= executions.length) this.selectedAgent = Math.max(0, executions.length - 1);
    const agentPane = [
      `RUN ${text(run.status, 'unknown')}`,
      'AGENTS',
      ...executions.map((entry, index) => clip(`${index === this.selectedAgent ? '>' : ' '} ${executionText(object(entry), agentWidth - 2)}`, agentWidth)),
      ...(this.agentLog
        ? ['', `${this.agentLog.fallback ? 'EVENT FALLBACK' : this.agentLog.following ? 'FOLLOWING LOG' : 'AGENT LOG'} ${this.agentLog.agentId}`,
          ...this.agentLog.lines.slice(-Math.max(2, rows - executions.length - 6)).map((line) => clip(line, agentWidth))]
        : [])
    ];
    const contentRows = rows - 2;
    const rendered = Array.from({ length: contentRows }, (_value, index) => {
      const projectLine = projectPane[index] ?? '';
      const eventLine = eventPane[index] ?? '';
      const agentLine = agentPane[index] ?? '';
      return `${projectLine.padEnd(projectWidth)} │ ${eventLine.padEnd(eventWidth)} │ ${agentLine}`;
    });
    const title = clip(` Agent Team Attach  ${this.runId} `, columns);
    const hint = 'arrows select agent  Enter/a answer  d deny approval  l tail  f follow log  q/Ctrl-C detach';
    const styledTitle = this.color === 'never' ? title : `\x1b[1m${title}\x1b[0m`;
    const styledHint = this.color === 'never' ? hint : `\x1b[2m${hint}\x1b[0m`;
    this.output.write(`\x1b[H\x1b[2J${styledTitle}\n${rendered.join('\n')}\n${styledHint}`);
  }

  private text(): string {
    const run = object(this.state.run);
    const executions = array(this.state.agentExecutions);
    const interactions = array(this.state.interactions).filter((item) => object(item).status === 'queued');
    return [
      `Run ${this.runId}: ${text(run.status, 'unknown')}`,
      `Tasks: ${array(this.state.tasks).length}`,
      `Agents: ${executions.map((entry) => executionText(object(entry), 160)).join('; ') || 'none'}`,
      `Pending interactions: ${interactions.length}`,
      ...this.lines
    ].join('\n');
  }
}

/** Keyboard-only run picker used before a controller lease is acquired. */
export class AttachRunSelectorUi {
  private selected = 0;
  private active = false;
  private readonly choices: unknown[];

  constructor(
    private readonly projects: unknown[],
    runs: unknown[],
    private readonly output: TerminalOutput = process.stdout,
    private readonly color: TuiColorPreference = 'auto'
  ) {
    this.choices = orderedRuns(projects, runs);
  }

  get isInteractive(): boolean {
    return Boolean(this.output.isTTY && this.output.columns && this.output.rows);
  }

  get selectedRunId(): string | undefined {
    return text(object(this.choices[this.selected]).id) || undefined;
  }

  start(): void {
    if (!this.isInteractive) {
      this.output.write(`${this.text()}\n`);
      return;
    }
    this.active = true;
    this.output.write('\x1b[?1049h\x1b[?25l');
    this.render();
  }

  move(delta: number): void {
    if (this.choices.length === 0) return;
    this.selected = (this.selected + delta + this.choices.length) % this.choices.length;
    this.render();
  }

  selectAt(row: number): void {
    const choice = runAtLine(this.projects, this.choices, row - 2);
    if (!choice) return;
    const index = this.choices.indexOf(choice);
    if (index < 0) return;
    this.selected = index;
    this.render();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.output.write('\x1b[?1049l\x1b[?25h');
  }

  private render(): void {
    if (!this.active) return;
    const columns = Math.max(60, this.output.columns ?? 120);
    const rows = Math.max(12, this.output.rows ?? 30);
    const selectedRunId = this.selectedRunId ?? '';
    const lines = projectRunLines(this.projects, this.choices, selectedRunId, columns - 2);
    const title = this.color === 'never'
      ? ' Agent Team Runs '
      : '\x1b[1m Agent Team Runs \x1b[0m';
    const body = lines.slice(0, rows - 2).join('\n');
    this.output.write(`\x1b[H\x1b[2J${title}\n${body}\nUp/Down select  Enter attach  q/Ctrl-C detach`);
  }

  private text(): string {
    const lines = projectRunLines(this.projects, this.choices, '', 160);
    return [`Available projects and runs:`, ...lines.slice(1)].join('\n');
  }
}

/** Safely formats the durable AGENT_EVENT payload without treating it as trusted input. */
export function formatAttachEvent(value: unknown): string | null {
  const record = object(value);
  const eventType = text(record.eventType);
  if (!eventType) return null;
  const payload = object(record.payload);
  const execution = object(payload.execution);
  const event = agentEvent(payload.event);
  if (eventType === 'AGENT_EVENT') {
    if (!event) return `[${text(execution.agentId, 'unknown')}] invalid AGENT_EVENT`;
    const formatted = formatEvent(event);
    return formatted ? `[${text(execution.agentId, 'unknown')}] ${formatted}` : null;
  }
  return `${eventType}${record.taskId ? ` ${text(record.taskId)}` : ''}${Object.keys(payload).length > 0 ? ` ${clip(stringify(payload), 120)}` : ''}`;
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

function interactionText(entry: Record<string, unknown>, width: number): string {
  return clip(`${text(entry.kind, 'unknown')} ${text(entry.taskId)} ${text(entry.agentId, 'unknown')}`, width);
}

function projectRunLines(projects: unknown[], runs: unknown[], currentRunId: string, width: number): string[] {
  const byProject = new Map<string, unknown[]>();
  for (const run of runs) {
    const projectId = text(object(run).projectId, 'unassigned');
    const entries = byProject.get(projectId) ?? [];
    entries.push(run);
    byProject.set(projectId, entries);
  }
  const lines = ['PROJECTS / RUNS'];
  const listed = new Set<string>();
  for (const project of projects) {
    const entry = object(project);
    const projectId = text(entry.id);
    listed.add(projectId);
    lines.push(clip(text(entry.displayName, projectId || 'unknown project'), width));
    for (const run of byProject.get(projectId) ?? []) lines.push(runLine(object(run), currentRunId, width));
  }
  for (const [projectId, projectRuns] of byProject) {
    if (listed.has(projectId)) continue;
    lines.push(clip(projectId === 'unassigned' ? 'Unassigned runs' : projectId, width));
    for (const run of projectRuns) lines.push(runLine(object(run), currentRunId, width));
  }
  return lines;
}

function orderedRuns(projects: unknown[], runs: unknown[]): unknown[] {
  const byProject = new Map<string, unknown[]>();
  for (const run of runs) {
    const projectId = text(object(run).projectId, 'unassigned');
    const entries = byProject.get(projectId) ?? [];
    entries.push(run);
    byProject.set(projectId, entries);
  }
  const ordered: unknown[] = [];
  const listed = new Set<string>();
  for (const project of projects) {
    const projectId = text(object(project).id);
    listed.add(projectId);
    ordered.push(...(byProject.get(projectId) ?? []));
  }
  for (const [projectId, projectRuns] of byProject) {
    if (!listed.has(projectId)) ordered.push(...projectRuns);
  }
  return ordered;
}

function runAtLine(projects: unknown[], runs: unknown[], target: number): unknown | undefined {
  const byProject = new Map<string, unknown[]>();
  for (const run of runs) {
    const projectId = text(object(run).projectId, 'unassigned');
    const entries = byProject.get(projectId) ?? [];
    entries.push(run);
    byProject.set(projectId, entries);
  }
  let line = 1; // Skip the PROJECTS / RUNS header.
  const listed = new Set<string>();
  for (const project of projects) {
    const projectId = text(object(project).id);
    listed.add(projectId);
    line += 1;
    for (const run of byProject.get(projectId) ?? []) {
      if (line === target) return run;
      line += 1;
    }
  }
  for (const [projectId, projectRuns] of byProject) {
    if (listed.has(projectId)) continue;
    line += 1;
    for (const run of projectRuns) {
      if (line === target) return run;
      line += 1;
    }
  }
  return undefined;
}

function runLine(run: Record<string, unknown>, currentRunId: string, width: number): string {
  const id = text(run.id, 'unknown');
  return clip(`${id === currentRunId ? '>' : ' '} ${id} ${text(run.status, 'unknown')}`, width);
}

function formatEvent(event: AgentEvent): string | null {
  if (event.type === 'activity') return null;
  if (event.type === 'session') return `session ${event.sessionId}`;
  if (event.type === 'session-status') return null;
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
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() : fallback;
}

function clip(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 3))}...`;
}
