// In-memory Herdr test double: scripted agent state machines, fault
// injection (failed starts, pane drops, server restarts) and a call log so
// tests can assert invariants like "prompt sent exactly once".

import type { HerdrRuntimeClient } from './client.ts';
import { atomicWriteJson } from '../results/files.ts';
import { join } from 'node:path';
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

export interface FakeAgentScript {
  kind: string;
  /** States walked after each prompt; last state persists. */
  sequence: HerdrAgentState[];
  /** Per-step delay in ms (default 10). */
  stepMs?: number;
  /** When the walk reaches a state, optionally write the role result file. */
  onState?: Partial<Record<HerdrAgentState, { writeResultFile: unknown }>>;
}

export interface FakeFaults {
  /** Agent names whose start fails. */
  failAgentStart?: string[];
  /** Panes removed without notice (server-restart subset). */
  dropPaneIds?: string[];
  /** Wipe every resource after N ms (full server restart). */
  restartServerAfterMs?: number;
}

export interface FakeOptions {
  scripts?: Record<string, FakeAgentScript>;
  faults?: FakeFaults;
  /** Directory for worktrees and simulated result file writes. */
  fsRoot: string;
}

interface FakeWorkspace extends WorkspaceHandle {}
interface FakeAgent extends AgentRecord {
  prompts: string[];
}

export interface RecordedCall {
  method: string;
  args: unknown;
  at: number;
}

export class FakeHerdrClient implements HerdrRuntimeClient {
  readonly calls: RecordedCall[] = [];
  private seq = 0;
  private readonly workspaces = new Map<string, FakeWorkspace>();
  private readonly panes = new Map<string, PaneHandle>();
  private readonly agents = new Map<string, FakeAgent>();
  private readonly selfReports: Array<{ paneId: string; agent: string; state: HerdrAgentState; message?: string }> = [];
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: FakeOptions) {
    if (opts.faults?.restartServerAfterMs !== undefined) {
      this.restartTimer = setTimeout(() => this.restartServer(), opts.faults.restartServerAfterMs);
    }
  }

  /** Test hook: inspect current self-reported runner state. */
  getSelfReports(): ReadonlyArray<{ paneId: string; agent: string; state: HerdrAgentState; message?: string }> {
    return this.selfReports;
  }

  /** Test hook: simulate the agent writing its result file. */
  async writeResultFile(agentName: string, result: unknown): Promise<void> {
    const agent = this.agents.get(agentName);
    if (!agent) throw new Error(`fake: unknown agent ${agentName}`);
    const resultPath = parseResultFilePath(agent.prompts[agent.prompts.length - 1] ?? '');
    if (!resultPath) throw new Error(`fake: agent ${agentName} has no result path in prompt`);
    await atomicWriteJson(resultPath, result);
  }

  /** Test hook: drop a pane like a crashed terminal. */
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
    let total = 0;
    for (const [name, agent] of this.agents) {
      if (agentName === undefined || name === agentName) total += agent.prompts.length;
    }
    return total;
  }

  private record(method: string, args: unknown): void {
    this.calls.push({ method, args, at: Date.now() });
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

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
    const slug = input.branch.replaceAll('/', '-');
    const handle: FakeWorkspace = {
      workspace: { workspaceId: wsId, label: input.label, worktree: { branch: input.branch, path: join(this.opts.fsRoot, 'worktrees', slug) } },
      tab: { tabId, workspaceId: wsId },
      rootPane: { paneId, workspaceId: wsId, tabId },
      worktree: { workspaceId: wsId, branch: input.branch, path: join(this.opts.fsRoot, 'worktrees', slug) },
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
    this.workspaces.delete(input.workspaceId);
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
    if (!this.panes.has(input.paneId)) throw new HerdrError('not_found', `fake: pane ${input.paneId} gone`);
    const script = this.opts.scripts?.[input.name];
    const agent: FakeAgent = {
      name: input.name,
      paneId: input.paneId,
      state: 'idle',
      kind: input.kind,
      prompts: [],
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
    this.walkSequence(input.target);
    if (input.wait) {
      await this.waitFor(input.target, input.until as HerdrAgentState[], input.timeoutMs);
    }
    return { paneId: agent.paneId, state: this.agents.get(input.target)?.state ?? 'unknown' };
  }

  private walkSequence(agentName: string): void {
    const agent = this.agents.get(agentName);
    const script = this.opts.scripts?.[agentName];
    if (!agent || !script || script.sequence.length === 0) return;
    const stepMs = script.stepMs ?? 10;
    let index = 0;
    const step = (): void => {
      const current = this.agents.get(agentName);
      if (!current) return;
      const state = script.sequence[Math.min(index, script.sequence.length - 1)]!;
      current.state = state;
      const onState = script.onState?.[state];
      if (onState) {
        const resultPath = parseResultFilePath(current.prompts[current.prompts.length - 1] ?? '');
        if (resultPath) {
          void atomicWriteJson(resultPath, onState.writeResultFile).catch(() => {});
        }
      }
      index += 1;
      if (index < script.sequence.length) setTimeout(step, stepMs);
    };
    setTimeout(step, stepMs);
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

  async waitAgent(input: { target: string; until: Array<'done' | 'blocked'>; timeoutMs?: number }): Promise<AgentWaitResult> {
    this.record('waitAgent', input);
    return this.waitFor(input.target, input.until, input.timeoutMs ?? 30_000);
  }

  async getAgent(target: string): Promise<AgentRecord | null> {
    this.record('getAgent', target);
    const agent = this.agents.get(target);
    return agent ? { ...agent, prompts: undefined } as unknown as AgentRecord : null;
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
      agents: [...this.agents.values()].map(({ prompts, ...rest }) => {
        void prompts;
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
