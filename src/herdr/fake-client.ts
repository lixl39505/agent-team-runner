// In-memory Herdr test double with REAL git worktrees: worktree creation
// actually runs `git worktree add` against a fixture repo so the engine's
// git gates run for real. Agents are scripted state machines with
// pause/resume (simulating native blocked UI) and file-edit actions.

import type { HerdrRuntimeClient } from './client.ts';
import { atomicWriteJson } from '../results/files.ts';
import { join, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type {
  AgentRecord,
  AgentWaitResult,
  HerdrEvent,
  HerdrEventStream,
  HerdrProbe,
  HerdrSessionSnapshot,
  PaneHandle,
  WorkspaceHandle,
} from './types.ts';
import { HerdrError } from './types.ts';
import type { HerdrAgentState } from '../core/types.ts';

export interface FakeAgentAction {
  /** Absolute-path write of the role result file (the commit point). */
  writeResultFile?: unknown;
  /** Files to edit inside the agent's worktree (relative paths). */
  editFiles?: Array<[string, string]>;
}

export interface FakeAgentScript {
  kind: string;
  /** States walked after each prompt; last state persists. */
  sequence: HerdrAgentState[];
  /** Per-step delay in ms (default 10). */
  stepMs?: number;
  /** Stop the walk at this state until resumeAgent() is called. */
  pauseAt?: HerdrAgentState;
  onState?: Partial<Record<HerdrAgentState, FakeAgentAction>>;
}

export interface FakeFaults {
  /** Agent names whose start fails. */
  failAgentStart?: string[];
  /** Wipe every resource after N ms (full server restart). */
  restartServerAfterMs?: number;
}

export interface FakeOptions {
  scripts?: Record<string, FakeAgentScript>;
  faults?: FakeFaults;
  /** Directory for worktrees and simulated result file writes. */
  fsRoot: string;
  /** Real repository used for `git worktree add`. */
  repoRoot: string;
}

interface FakeAgent extends AgentRecord {
  prompts: string[];
  worktreePath: string;
  pausedAt: number | null;
}

export interface RecordedCall {
  method: string;
  args: unknown;
  at: number;
}

async function git(repoRoot: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', '-C', repoRoot, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new HerdrError('herdr_error', `fake: git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

export class FakeHerdrClient implements HerdrRuntimeClient {
  readonly calls: RecordedCall[] = [];
  private seq = 0;
  private readonly workspaces = new Map<string, WorkspaceHandle>();
  private readonly panes = new Map<string, PaneHandle>();
  private readonly agents = new Map<string, FakeAgent>();
  /** Survives pane closure/restarts — prompts are the invariant under test. */
  private readonly promptLog: Array<{ agent: string; text: string }> = [];
  private readonly selfReports: Array<{ paneId: string; agent: string; state: HerdrAgentState; message?: string }> = [];
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: FakeOptions) {
    // base workspace standing in for the Runner's own Herdr workspace
    this.workspaces.set('w0', {
      workspace: { workspaceId: 'w0', label: 'base', worktree: { branch: '(base)', path: opts.repoRoot } },
      tab: { tabId: 'w0:t', workspaceId: 'w0' },
      rootPane: { paneId: 'w0:p', workspaceId: 'w0', tabId: 'w0:t' },
      worktree: { workspaceId: 'w0', branch: '(base)', path: opts.repoRoot },
    });
    this.panes.set('w0:p', { paneId: 'w0:p', workspaceId: 'w0', tabId: 'w0:t' });
    if (opts.faults?.restartServerAfterMs !== undefined) {
      this.restartTimer = setTimeout(() => this.restartServer(), opts.faults.restartServerAfterMs);
    }
  }

  // ------------------------------------------------------------ test hooks

  getSelfReports(): ReadonlyArray<{ paneId: string; agent: string; state: HerdrAgentState; message?: string }> {
    return this.selfReports;
  }

  dropPane(paneId: string): void {
    this.panes.delete(paneId);
    for (const [name, agent] of this.agents) {
      if (agent.paneId === paneId) this.agents.delete(name);
    }
  }

  restartServer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.workspaces.clear();
    this.panes.clear();
    this.agents.clear();
  }

  agentCount(): number {
    return this.agents.size;
  }

  promptCount(agentName?: string): number {
    return this.promptLog.filter((p) => agentName === undefined || p.agent === agentName).length;
  }

  agentState(name: string): HerdrAgentState | null {
    return this.agents.get(name)?.state ?? null;
  }

  worktreeOf(workspaceId: string): string | null {
    return this.workspaces.get(workspaceId)?.worktree.path ?? null;
  }

  async writeResultFile(agentName: string, result: unknown): Promise<void> {
    const agent = this.agents.get(agentName);
    if (!agent) throw new Error(`fake: unknown agent ${agentName}`);
    const resultPath = parseResultFilePath(agent.prompts[agent.prompts.length - 1] ?? '');
    if (!resultPath) throw new Error(`fake: agent ${agentName} has no result path in prompt`);
    await atomicWriteJson(resultPath, result);
  }

  /** Continue a walk paused at script.pauseAt (simulates the user resolving native UI). */
  resumeAgent(agentName: string): void {
    const agent = this.agents.get(agentName);
    const script = this.opts.scripts?.[agentName];
    if (!agent || !script || agent.pausedAt === null) return;
    const from = agent.pausedAt + 1;
    agent.pausedAt = null;
    this.walkFrom(agentName, from);
  }

  /** Test hook: apply edit/result actions as if the agent just did them. */
  async performAction(agentName: string, action: FakeAgentAction): Promise<void> {
    await this.applyAction(agentName, action);
  }

  // ------------------------------------------------------------- internals

  private record(method: string, args: unknown): void {
    this.calls.push({ method, args, at: Date.now() });
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  private async applyAction(agentName: string, action: FakeAgentAction): Promise<void> {
    const agent = this.agents.get(agentName);
    if (!agent) return;
    if (action.editFiles) {
      for (const [rel, content] of action.editFiles) {
        const path = join(agent.worktreePath, rel);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, 'utf8');
      }
    }
    if (action.writeResultFile !== undefined) {
      const resultPath = parseResultFilePath(agent.prompts[agent.prompts.length - 1] ?? '');
      if (resultPath) await atomicWriteJson(resultPath, action.writeResultFile);
    }
  }

  private walkFrom(agentName: string, from: number): void {
    const script = this.opts.scripts?.[agentName];
    if (!script || from >= script.sequence.length) return;
    const stepMs = script.stepMs ?? 10;
    let index = from;
    // actions complete BEFORE the state becomes visible, so a waiter that
    // observes `done` can immediately read the result file
    const step = async (): Promise<void> => {
      const current = this.agents.get(agentName);
      if (!current) return;
      const state = script.sequence[index]!;
      const action = script.onState?.[state];
      if (action) {
        try {
          await this.applyAction(agentName, action);
        } catch {
          /* best effort */
        }
      }
      current.state = state;
      if (script.pauseAt !== undefined && state === script.pauseAt && index < script.sequence.length - 1) {
        current.pausedAt = index;
        return;
      }
      index += 1;
      if (index < script.sequence.length) setTimeout(() => void step(), stepMs);
    };
    setTimeout(() => void step(), stepMs);
  }

  private waitFor(target: string, until: HerdrAgentState[], timeoutMs: number): Promise<AgentWaitResult> {
    const deadline = Date.now() + Math.min(timeoutMs, 30_000);
    return new Promise((resolve, reject) => {
      const poll = (): void => {
        const agent = this.agents.get(target);
        if (!agent) {
          reject(new HerdrError('agent_not_found', `fake: agent ${target} gone while waiting`));
          return;
        }
        if (until.includes(agent.state)) {
          resolve({ paneId: agent.paneId, state: agent.state });
          return;
        }
        if (Date.now() > deadline) {
          reject(new HerdrError('timeout', `fake: wait timeout for ${target}`));
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    });
  }

  // ------------------------------------------------------------ client API

  async probe(): Promise<HerdrProbe> {
    this.record('probe', {});
    return {
      version: '0.8.0-fake',
      protocolOk: true,
      transport: 'cli',
      capabilities: { worktree: true, agent: true, sessionSnapshot: true, reportAgent: true, plugin: true },
    };
  }

  async createWorktreeWorkspace(input: {
    sourceWorkspaceId: string;
    branch: string;
    label?: string;
    focus?: boolean;
  }): Promise<WorkspaceHandle> {
    this.record('createWorktreeWorkspace', input);
    const wsId = this.nextId('w');
    const tabId = `${wsId}:t`;
    const paneId = `${wsId}:p`;
    const path = join(this.opts.fsRoot, 'worktrees', input.branch.replaceAll('/', '-'));
    // branch exists → checkout; otherwise create from current HEAD (Herdr semantics)
    const branchProc = Bun.spawn(['git', '-C', this.opts.repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`], {
      stdout: 'ignore', stderr: 'ignore', stdin: 'ignore',
    });
    const exists = (await branchProc.exited) === 0;
    await git(this.opts.repoRoot, exists ? ['worktree', 'add', path, input.branch] : ['worktree', 'add', '-b', input.branch, path]);
    const handle: WorkspaceHandle = {
      workspace: { workspaceId: wsId, label: input.label, worktree: { branch: input.branch, path } },
      tab: { tabId, workspaceId: wsId },
      rootPane: { paneId, workspaceId: wsId, tabId },
      worktree: { workspaceId: wsId, branch: input.branch, path },
    };
    this.workspaces.set(wsId, handle);
    this.panes.set(paneId, handle.rootPane);
    return handle;
  }

  async openWorktree(input: { sourceWorkspaceId: string; branch?: string; path?: string }): Promise<WorkspaceHandle> {
    this.record('openWorktree', input);
    for (const handle of this.workspaces.values()) {
      if (input.branch && handle.worktree.branch === input.branch) return handle;
      if (input.path && handle.worktree.path === input.path) return handle;
    }
    throw new HerdrError('not_found', `fake: worktree not open for ${input.branch ?? input.path}`);
  }

  async removeWorktree(input: { workspaceId: string; force?: boolean }): Promise<void> {
    this.record('removeWorktree', input);
    const handle = this.workspaces.get(input.workspaceId);
    if (handle) {
      await git(this.opts.repoRoot, ['worktree', 'remove', ...(input.force ? ['--force'] : []), handle.worktree.path]);
      this.workspaces.delete(input.workspaceId);
      this.panes.delete(handle.rootPane.paneId);
    }
  }

  async splitPane(input: { paneId: string; direction?: 'right' | 'down'; label?: string }): Promise<PaneHandle> {
    this.record('splitPane', input);
    const parent = this.panes.get(input.paneId);
    if (!parent) throw new HerdrError('not_found', `fake: pane ${input.paneId} not found`);
    const paneId = `${parent.workspaceId}:p${this.nextId('')}`;
    const handle: PaneHandle = { paneId, workspaceId: parent.workspaceId, tabId: parent.tabId };
    this.panes.set(paneId, handle);
    return handle;
  }

  async closePane(paneId: string): Promise<void> {
    this.record('closePane', paneId);
    this.dropPane(paneId);
  }

  async focusPane(paneId: string): Promise<void> {
    this.record('focusPane', paneId);
  }

  async startAgent(input: { name: string; kind: string; paneId: string; args: string[] }): Promise<AgentRecord> {
    this.record('startAgent', input);
    if (this.opts.faults?.failAgentStart?.includes(input.name)) {
      throw new HerdrError('herdr_error', `fake: agent start failed for ${input.name}`);
    }
    const pane = this.panes.get(input.paneId);
    if (!pane) throw new HerdrError('not_found', `fake: pane ${input.paneId} gone`);
    const script = this.opts.scripts?.[input.name];
    const ws = this.workspaces.get(pane.workspaceId);
    const agent: FakeAgent = {
      name: input.name,
      paneId: input.paneId,
      state: 'idle',
      kind: input.kind,
      prompts: [],
      worktreePath: ws?.worktree.path ?? this.opts.repoRoot,
      pausedAt: null,
    };
    this.agents.set(input.name, agent);
    if (!script) agent.state = 'unknown';
    return { ...agent };
  }

  async promptAgent(input: {
    target: string;
    text: string;
    wait: boolean;
    until: Array<'idle' | 'done' | 'blocked'>;
    timeoutMs: number;
  }): Promise<AgentWaitResult> {
    this.record('promptAgent', input);
    const agent = this.agents.get(input.target);
    if (!agent) throw new HerdrError('agent_not_found', `fake: agent ${input.target} not found`);
    agent.prompts.push(input.text);
    this.promptLog.push({ agent: input.target, text: input.text });
    this.walkFrom(input.target, 0);
    if (input.wait) {
      return this.waitFor(input.target, input.until as HerdrAgentState[], input.timeoutMs);
    }
    return { paneId: agent.paneId, state: agent.state };
  }

  async waitAgent(input: { target: string; until: Array<'done' | 'blocked'>; timeoutMs?: number }): Promise<AgentWaitResult> {
    this.record('waitAgent', input);
    return this.waitFor(input.target, input.until, input.timeoutMs ?? 30_000);
  }

  async getAgent(target: string): Promise<AgentRecord | null> {
    this.record('getAgent', target);
    const agent = this.agents.get(target);
    if (!agent) return null;
    return { name: agent.name, paneId: agent.paneId, state: agent.state, kind: agent.kind };
  }

  async readPane(input: { paneId: string; source?: string; lines?: number }): Promise<string> {
    this.record('readPane', input);
    return `[fake pane ${input.paneId} output]`;
  }

  async reportAgentState(input: { paneId: string; agent: string; state: HerdrAgentState; message?: string }): Promise<void> {
    this.record('reportAgentState', input);
    this.selfReports.push(input);
  }

  async snapshot(): Promise<HerdrSessionSnapshot> {
    this.record('snapshot', {});
    return {
      workspaces: [...this.workspaces.values()].map((w) => w.workspace),
      tabs: [...this.workspaces.values()].map((w) => w.tab),
      panes: [...this.panes.values()],
      agents: [...this.agents.values()].map(({ prompts, worktreePath, pausedAt, ...rest }) => {
        void prompts;
        void worktreePath;
        void pausedAt;
        return rest;
      }),
    };
  }

  async subscribe(): Promise<HerdrEventStream> {
    this.record('subscribe', {});
    const empty: HerdrEventStream = {
      async *[Symbol.asyncIterator](): AsyncIterator<HerdrEvent> {
        // never yields — tests drive state directly
      },
      close(): void {},
    };
    return empty;
  }
}

export function parseResultFilePath(promptText: string): string | null {
  const m = /^RESULT FILE: (.+)$/m.exec(promptText);
  return m ? m[1]!.trim() : null;
}
