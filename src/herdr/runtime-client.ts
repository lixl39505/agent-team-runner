// HerdrRuntimeClient over the CLI transport. Argv mapping is centralized
// here; response shapes are normalized defensively so e2e against the real
// Herdr only needs mapping fixes, not interface changes.

import type { HerdrRuntimeClient } from './client.ts';
import { HerdrCliTransport, bunSpawner } from './cli-transport.ts';
import { HerdrError } from './types.ts';
import { HerdrSocketTransport } from './socket-transport.ts';
import type {
  AgentRecord,
  AgentWaitResult,
  HerdrProbe,
  HerdrSessionSnapshot,
  PaneHandle,
  WorkspaceHandle,
} from './types.ts';
import type { HerdrAgentState } from '../core/types.ts';
import { detectCapabilities, isVersionAtLeast, MINIMUM_HERDR_VERSION } from './versions.ts';

type AnyRecord = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function pick(obj: AnyRecord | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

/** Socket responses arrive as {id, result}; some CLIs print the result body directly. */
function unwrapResult<T>(doc: unknown): T {
  if (typeof doc === 'object' && doc !== null && 'result' in (doc as AnyRecord)) {
    return (doc as AnyRecord).result as T;
  }
  return doc as T;
}

function mapWorkspace(raw: AnyRecord | undefined) {
  const worktreeRaw = pick(raw, 'worktree') as AnyRecord | undefined;
  return {
    workspaceId: str(pick(raw, 'workspace_id', 'id')) ?? '',
    label: str(pick(raw, 'label')),
    cwd: str(pick(raw, 'cwd')),
    worktree: worktreeRaw
      ? {
          branch: str(pick(worktreeRaw, 'branch')) ?? '',
          path: str(pick(worktreeRaw, 'path')) ?? '',
          repoRoot: str(pick(worktreeRaw, 'repo_root')),
        }
      : undefined,
  };
}

function mapTab(raw: AnyRecord | undefined) {
  return {
    tabId: str(pick(raw, 'tab_id', 'id')) ?? '',
    workspaceId: str(pick(raw, 'workspace_id')) ?? '',
    label: str(pick(raw, 'label')),
  };
}

function mapPane(raw: AnyRecord | undefined): PaneHandle {
  return {
    paneId: str(pick(raw, 'pane_id', 'id')) ?? '',
    workspaceId: str(pick(raw, 'workspace_id')) ?? '',
    tabId: str(pick(raw, 'tab_id')) ?? '',
  };
}

function mapWorktree(raw: AnyRecord | undefined) {
  return {
    workspaceId: str(pick(raw, 'workspace_id')) ?? '',
    branch: str(pick(raw, 'branch')) ?? '',
    path: str(pick(raw, 'path')) ?? '',
  };
}

function mapAgent(raw: AnyRecord | undefined): AgentRecord {
  const session = pick(raw, 'agent_session') as AnyRecord | undefined;
  return {
    name: str(pick(raw, 'name', 'agent')) ?? null,
    paneId: str(pick(raw, 'pane_id', 'pane')) ?? '',
    state: (str(pick(raw, 'state', 'agent_status', 'status')) ?? 'unknown') as HerdrAgentState,
    kind: str(pick(raw, 'kind')) ?? undefined,
    model: str(pick(raw, 'model')) ?? null,
    nativeSessionRef:
      session && typeof session === 'object' ? str(pick(session, 'value', 'session_id')) ?? null : null,
  };
}

function requireWorkspaceHandle(doc: unknown, what: string): WorkspaceHandle {
  const result = unwrapResult<AnyRecord>(doc);
  const workspace = mapWorkspace(pick(result, 'workspace') as AnyRecord | undefined);
  const tab = mapTab(pick(result, 'tab') as AnyRecord | undefined);
  const rootPane = mapPane(pick(result, 'root_pane', 'rootPane', 'pane') as AnyRecord | undefined);
  if (!workspace.workspaceId || !rootPane.paneId) {
    throw new HerdrError('invalid_response', `${what} response missing workspace/tab/pane records`, doc);
  }
  const worktree = mapWorktree(pick(result, 'worktree') as AnyRecord | undefined);
  if (!worktree.path || !worktree.branch) {
    throw new HerdrError('invalid_response', `${what} response missing worktree provenance`, doc);
  }
  return { workspace, tab, rootPane, worktree };
}

export interface HerdrRuntimeClientOptions {
  herdrPath?: string;
  defaultTimeoutMs?: number;
  argvPrefix?: readonly string[];
}

export class HerdrCliRuntimeClient implements HerdrRuntimeClient {
  private readonly cli: HerdrCliTransport;
  private readonly defaultTimeoutMs: number;

  constructor(opts: HerdrRuntimeClientOptions = {}) {
    this.cli = new HerdrCliTransport(opts.herdrPath, bunSpawner, opts.argvPrefix);
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  async probe(): Promise<HerdrProbe> {
    const version = await this.cli.callText(['--version'], { timeoutMs: 10_000 });
    let capabilities = {
      worktree: false,
      agent: false,
      sessionSnapshot: false,
      reportAgent: false,
      plugin: false,
    };
    let protocolOk = false;
    try {
      const schema = await this.cli.callJson<unknown>(['api', 'schema', '--json'], { timeoutMs: 15_000 });
      capabilities = detectCapabilities(schema);
      protocolOk = isVersionAtLeast(version, MINIMUM_HERDR_VERSION);
    } catch (err) {
      if (err instanceof HerdrError && err.code === 'timeout') throw err;
      // schema unsupported → protocol below minimum expectations
      protocolOk = false;
    }
    return { version, protocolOk, transport: 'cli', capabilities };
  }

  async createWorktreeWorkspace(input: {
    sourceWorkspaceId: string;
    branch: string;
    label?: string;
    focus?: boolean;
  }): Promise<WorkspaceHandle> {
    // herdr 0.9.x: API-backed subcommands print the {id, result} JSON envelope
    // by default and REJECT an explicit --json flag (exit 2 usage error)
    const args = ['worktree', 'create', '--workspace', input.sourceWorkspaceId, '--branch', input.branch];
    if (input.label) args.push('--label', input.label);
    if (input.focus === false) args.push('--no-focus');
    return requireWorkspaceHandle(await this.cli.callJson<unknown>(args), 'worktree.create');
  }

  async openWorktree(input: { sourceWorkspaceId: string; branch?: string; path?: string }): Promise<WorkspaceHandle> {
    const args = ['worktree', 'open', '--workspace', input.sourceWorkspaceId];
    if (input.branch) args.push('--branch', input.branch);
    if (input.path) args.push('--path', input.path);
    return requireWorkspaceHandle(await this.cli.callJson<unknown>(args), 'worktree.open');
  }

  async removeWorktree(input: { workspaceId: string; force?: boolean }): Promise<void> {
    const args = ['worktree', 'remove', '--workspace', input.workspaceId];
    if (input.force) args.push('--force');
    await this.cli.callJson<unknown>(args);
  }

  async splitPane(input: { paneId: string; direction?: 'right' | 'down'; label?: string }): Promise<PaneHandle> {
    const args = ['pane', 'split', input.paneId, '--direction', input.direction ?? 'right', '--no-focus'];
    const doc = unwrapResult<AnyRecord>(await this.cli.callJson<unknown>(args));
    const pane = mapPane(pick(doc, 'pane') as AnyRecord | undefined);
    if (!pane.paneId) throw new HerdrError('invalid_response', 'pane.split response missing pane record', doc);
    return pane;
  }

  async closePane(paneId: string): Promise<void> {
    await this.cli.callJson<unknown>(['pane', 'close', paneId]);
  }

  async focusPane(paneId: string): Promise<void> {
    await this.cli.callText(['pane', 'focus', paneId]);
  }

  async startAgent(input: {
    name: string;
    kind: string;
    paneId: string;
    args: string[];
    readyTimeoutMs?: number;
  }): Promise<AgentRecord> {
    const args = [
      'agent', 'start', input.name,
      '--kind', input.kind,
      '--pane', input.paneId,
      '--timeout', String(input.readyTimeoutMs ?? 30_000),
      '--',
      ...input.args,
    ];
    const doc = unwrapResult<AnyRecord>(await this.cli.callJson<unknown>(args, {
      timeoutMs: (input.readyTimeoutMs ?? 30_000) + 15_000,
    }));
    const agentRaw = pick(doc, 'agent') as AnyRecord | undefined;
    return mapAgent({ pane_id: input.paneId, name: input.name, ...(agentRaw ?? {}) });
  }

  async promptAgent(input: {
    target: string;
    text: string;
    wait: boolean;
    until: Array<'idle' | 'done' | 'blocked'>;
    timeoutMs: number;
    requestId?: string;
  }): Promise<AgentWaitResult> {
    const args = ['agent', 'prompt', input.target, input.text];
    if (input.wait) {
      args.push('--wait');
      for (const state of input.until) args.push('--until', state);
      args.push('--timeout', String(input.timeoutMs));
    }
    // NOTE (R2-10/R3-01): `requestId` is deliberately NOT mapped to a CLI
    // flag — no such flag exists in the current Herdr CLI, and inventing one
    // would fail every prompt. Because this transport cannot dedupe, it
    // reports supportsPromptDedup() === false: the runner must treat any
    // recovery re-send whose delivery is uncertain as needing manual
    // confirmation, never blind re-prompting.
    const doc = unwrapResult<AnyRecord>(await this.cli.callJson<unknown>(args, {
      timeoutMs: input.timeoutMs + 15_000,
    }));
    return { paneId: str(pick(doc, 'pane_id')) ?? '', state: (str(pick(doc, 'state', 'agent_status')) ?? 'unknown') as HerdrAgentState };
  }

  /** R3-01: the CLI has no verified request-id flag, so deliveries through
   * this transport are NOT idempotent — recovery may not re-send. */
  supportsPromptDedup(): boolean {
    return false;
  }

  async waitAgent(input: { target: string; until: Array<'done' | 'blocked'>; timeoutMs?: number }): Promise<AgentWaitResult> {
    const args = ['agent', 'wait', input.target];
    for (const state of input.until) args.push('--until', state);
    if (input.timeoutMs) args.push('--timeout', String(input.timeoutMs));
    const doc = unwrapResult<AnyRecord>(await this.cli.callJson<unknown>(args, {
      timeoutMs: (input.timeoutMs ?? 120_000) + 15_000,
    }));
    const pane = pick(doc, 'pane') as AnyRecord | undefined;
    return {
      paneId: str(pick(pane, 'pane_id')) ?? str(pick(doc, 'pane_id')) ?? '',
      state: (str(pick(pane, 'agent_status')) ?? str(pick(doc, 'state')) ?? 'unknown') as HerdrAgentState,
    };
  }

  async getAgent(target: string): Promise<AgentRecord | null> {
    const args = ['agent', 'get', target];
    // herdr 0.9.x reports a missing agent as a not_found ERROR; the interface
    // contract is null = "definitively gone" (the engine restarts on null,
    // escalates on errors) — so map that one code, propagate the rest
    const doc = await this.cli.callJson<unknown>(args).catch((err) => {
      if (err instanceof HerdrError && err.code === 'not_found') return null;
      throw err;
    });
    if (!doc || typeof doc !== 'object') return null;
    // 0.9.x shape: {type, agent: {...}} inside the envelope — unwrap the
    // agent record before mapping; the fixture/test shape is the record itself
    const body = unwrapResult<AnyRecord>(doc);
    const agentRaw = (pick(body, 'agent') as AnyRecord | undefined) ?? body;
    return mapAgent(agentRaw);
  }

  async readPane(input: { paneId: string; source?: string; lines?: number }): Promise<string> {
    const args = ['pane', 'read', input.paneId, '--source', input.source ?? 'recent-unwrapped'];
    if (input.lines) args.push('--lines', String(input.lines));
    return this.cli.callText(args);
  }

  async reportAgentState(input: {
    paneId: string;
    agent: string;
    state: HerdrAgentState;
    message?: string;
  }): Promise<void> {
    // herdr 0.9.x shape: positional <PANE_ID> plus a REQUIRED --source (the
    // reporting client's label); there is no --pane flag
    const args = [
      'pane', 'report-agent',
      '--source', input.agent,
      '--agent', input.agent,
      '--state', input.state,
    ];
    if (input.message) args.push('--message', input.message);
    args.push(input.paneId);
    await this.cli.callText(args); // 0.9.x acknowledges with empty output
  }

  async snapshot(): Promise<HerdrSessionSnapshot> {
    const result = unwrapResult<AnyRecord>(await this.cli.callJson<unknown>(['api', 'snapshot']));
    return normalizeSnapshot(result);
  }

  async subscribe(): Promise<never> {
    throw new HerdrError(
      'unsupported_transport',
      'event subscription requires the socket transport (M5); use polling for now',
    );
  }
}

/** Normalize a raw session.snapshot result body into domain records.
 * Both transports land here: the CLI envelope unwraps to
 * `{type, snapshot: {...}}` while the socket result is the same shape — the
 * optional `snapshot` wrapper is stripped FIRST, otherwise every workspace/
 * pane is invisible and reconcile judges live resources as lost. */
export function normalizeSnapshot(result: unknown): HerdrSessionSnapshot {
  const outer = (typeof result === 'object' && result !== null ? result : {}) as AnyRecord;
  const body = (pick(outer, 'snapshot') as AnyRecord | undefined) ?? outer;
  const workspaces = Array.isArray(pick(body, 'workspaces')) ? (pick(body, 'workspaces') as AnyRecord[]).map(mapWorkspace) : [];
  const tabs = Array.isArray(pick(body, 'tabs')) ? (pick(body, 'tabs') as AnyRecord[]).map(mapTab) : [];
  const panes = Array.isArray(pick(body, 'panes')) ? (pick(body, 'panes') as AnyRecord[]).map(mapPane) : [];
  const agents = Array.isArray(pick(body, 'agents')) ? (pick(body, 'agents') as AnyRecord[]).map(mapAgent) : [];
  return { version: str(pick(body, 'version')), workspaces, tabs, panes, agents };
}

/**
 * Hybrid client: CLI wrappers for lifecycle operations, raw socket for the
 * two operations that need a persistent connection (snapshot/subscribe).
 * Selected via ATEAM_HERDR_TRANSPORT=socket or a CLI client lacking
 * sessionSnapshot capability.
 */
export class HerdrHybridRuntimeClient implements HerdrRuntimeClient {
  constructor(
    private readonly cli: HerdrRuntimeClient,
    private readonly socket: HerdrSocketTransport,
  ) {}

  probe(): Promise<HerdrProbe> {
    return this.cli.probe();
  }
  createWorktreeWorkspace(input: Parameters<HerdrRuntimeClient['createWorktreeWorkspace']>[0]) {
    return this.cli.createWorktreeWorkspace(input);
  }
  openWorktree(input: Parameters<HerdrRuntimeClient['openWorktree']>[0]) {
    return this.cli.openWorktree(input);
  }
  removeWorktree(input: { workspaceId: string; force?: boolean }) {
    return this.cli.removeWorktree(input);
  }
  splitPane(input: { paneId: string; direction?: 'right' | 'down'; label?: string }) {
    return this.cli.splitPane(input);
  }
  async closePane(paneId: string): Promise<void> {
    await this.cli.closePane(paneId);
  }
  async focusPane(paneId: string): Promise<void> {
    await this.cli.focusPane(paneId);
  }
  startAgent(input: Parameters<HerdrRuntimeClient['startAgent']>[0]) {
    return this.cli.startAgent(input);
  }
  promptAgent(input: Parameters<HerdrRuntimeClient['promptAgent']>[0]) {
    return this.cli.promptAgent(input);
  }
  supportsPromptDedup(): boolean {
    // prompts ride the CLI wrapper here — dedupe follows the CLI's answer
    return this.cli.supportsPromptDedup();
  }
  waitAgent(input: Parameters<HerdrRuntimeClient['waitAgent']>[0]) {
    return this.cli.waitAgent(input);
  }
  getAgent(target: string) {
    return this.cli.getAgent(target);
  }
  readPane(input: Parameters<HerdrRuntimeClient['readPane']>[0]) {
    return this.cli.readPane(input);
  }
  reportAgentState(input: Parameters<HerdrRuntimeClient['reportAgentState']>[0]) {
    return this.cli.reportAgentState(input);
  }
  async snapshot(): Promise<HerdrSessionSnapshot> {
    try {
      return normalizeSnapshot(unwrapResult<AnyRecord>(await this.socket.snapshot()));
    } catch (err) {
      if (err instanceof HerdrError && (err.code === 'herdr_not_running' || err.code === 'timeout')) throw err;
      return this.cli.snapshot();
    }
  }
  subscribe(filter?: { paneId?: string }) {
    return this.socket.subscribe(filter);
  }
}

export function createRuntimeClient(opts: { herdrPath?: string; preferSocket?: boolean } = {}): HerdrRuntimeClient {
  const cli = new HerdrCliRuntimeClient(opts.herdrPath ? { herdrPath: opts.herdrPath } : {});
  if (opts.preferSocket ?? process.env.ATEAM_HERDR_TRANSPORT === 'socket') {
    return new HerdrHybridRuntimeClient(cli, new HerdrSocketTransport());
  }
  return cli;
}
