#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOverrides, initConfig, loadConfig } from './core/config.js';
import type { ConfigOverride } from './core/config.js';
import { StateDatabase } from './core/db.js';
import { ensureGitignore, syncSkills } from './core/files.js';
import { planRun } from './core/planner.js';
import { runOrchestrator } from './core/orchestrator.js';
import { formatRunStatus } from './core/status.js';
import { execFile, ensureGitRepo } from './core/git.js';
import { buildBackends, disposeBackends, parseSnapshot, snapshotAgents } from './agent/registry.js';
import { generatedProtocolVersion } from './agent/codex/generated.js';
import { backendCommand, isBackendId, isValidAgentName, validateAgents } from './core/agent-config.js';
import { bindingsForRun, checkAgentAvailability, probeAll } from './core/preflight.js';
import type { AgentBinding, BackendId, RunnerConfig } from './core/types.js';
import type { AgentBackend } from './agent/types.js';
import type { BackendPool } from './agent/registry.js';
import { TerminalApprovalBroker } from './agent/approval.js';
import { createCredentialStore } from './core/credentials.js';
import { promptMaskedSecret } from './core/terminal-input.js';
import { LiveRunUi } from './core/live-ui.js';

let argv: string[] = [];
let command: string | undefined;
let rawConfigOverrides: string[] = [];

function configOverrides(): ConfigOverride[] {
  return rawConfigOverrides.map((entry) => {
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid -c override "${entry}": expected <path>=<value>`);
    return { key: entry.slice(0, eq), value: entry.slice(eq + 1) };
  });
}

function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  argv.splice(index, 2);
  return value;
}

function flag(name: string): boolean {
  const index = argv.indexOf(name);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
}

function repoOption(): string {
  return resolve(option('--repo') ?? process.cwd());
}

function database(repoRoot: string): { config: RunnerConfig; db: StateDatabase } {
  const config = applyOverrides(loadConfig(repoRoot), configOverrides());
  mkdirSync(config.workspace.stateDir, { recursive: true });
  return { config, db: new StateDatabase(join(config.workspace.stateDir, 'state.sqlite')) };
}

async function preflight(config: RunnerConfig, bindings: AgentBinding[], validateSyntax: boolean): Promise<void> {
  if (validateSyntax) {
    const syntax = validateAgents(config);
    if (!syntax.ok) throw new Error(`Invalid agent config:\n  - ${syntax.errors.join('\n  - ')}`);
  }
  const backends = buildBackends(config);
  try {
    const availability = await checkAgentAvailability({ config, backends, bindings });
    for (const warning of availability.warnings) console.error(`warning: ${warning}`);
    if (!availability.ok) {
      throw new Error(`Agent preflight failed:\n  - ${availability.errors.join('\n  - ')}`);
    }
  } finally {
    disposeBackends(backends);
  }
}

async function main(): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'init') {
    const repoRoot = resolve(argv.shift() ?? process.cwd());
    await ensureGitRepo(repoRoot);
    const configFile = initConfig(repoRoot);
    ensureGitignore(repoRoot);
    const skills = syncSkills(repoRoot);
    console.log(`Initialized: ${configFile}`);
    console.log(`Synced ${skills.length} host skill files.`);
    return;
  }

  if (command === 'skills') {
    const subcommand = argv.shift();
    if (subcommand !== 'sync') throw new Error('Usage: agent-team skills sync [--repo PATH]');
    const repoRoot = repoOption();
    const skills = syncSkills(repoRoot);
    console.log(skills.join('\n'));
    return;
  }

  if (command === 'auth') {
    await runAuthCommand();
    return;
  }

  if (command === 'logs') {
    await runLogsCommand();
    return;
  }

  if (command === 'doctor') {
    const repoRoot = repoOption();
    const forceProbe = flag('--probe');
    const { config, db } = database(repoRoot);
    try {
      await ensureGitRepo(config.workspace.repoRoot);
      console.log(`Node: ${process.version}`);
      console.log(`Repository: ${config.workspace.repoRoot}`);
      console.log(`State DB: ${join(config.workspace.stateDir, 'state.sqlite')}`);
      const backends = buildBackends(config);
      try {
        const doctorBindings = (['claude', 'codex', 'opencode'] as BackendId[]).map((backend) => ({
          agent: `doctor-${backend}`, backend, source: 'doctor'
        }));
        console.log('Backends:');
        const generatedCodex = generatedProtocolVersion();
        for (const binding of doctorBindings) {
          const backend = await getBackend(backends, binding);
          const discovery = await backend.discover();
          const label = discovery.installed
            ? `${discovery.version ?? 'available'}${discovery.authed === false ? ' (not authenticated)' : ''}`
            : `unavailable${discovery.detail ? ` (${discovery.detail})` : ''}`;
          console.log(`  ${binding.backend}: ${label}`);
          // 协议类型新鲜度：app-server 协议是 experimental，类型快照必须与实际 CLI 版本一致
          if (binding.backend === 'codex' && generatedCodex && discovery.version && discovery.version.trim() !== generatedCodex) {
            console.log(`  warn: codex protocol types were generated for "${generatedCodex}" but installed CLI is "${discovery.version.trim()}"; run: npm run gen:codex && npm run check`);
          }
        }
        const snapshot = snapshotAgents(config);
        const syntax = validateAgents(config);
        console.log('Models:');
        for (const binding of doctorBindings) {
          try {
            const backend = await getBackend(backends, binding);
            const models = await backend.listModels();
            console.log(`  ${binding.backend}: ${models.length} models — ${models.slice(0, 6).map((model) => model.id).join(', ')}${models.length > 6 ? ', …' : ''}`);
          } catch (error) {
            console.log(`  ${binding.backend}: enumeration failed (${error instanceof Error ? error.message : String(error)})`);
          }
        }
        console.log('Agents:');
        for (const [name, entry] of Object.entries(config.agents)) {
          console.log(`  ${name}: ${entry.backend}${entry.model ? ` (${entry.model})` : ''}`);
        }
        console.log('Roles:');
        for (const [role, binding] of Object.entries(snapshot.roles)) {
          console.log(`  ${role}: ${binding.agent} → ${binding.backend}${binding.model ? ` (${binding.model})` : ''} [${binding.source}]`);
        }
        const availability = await checkAgentAvailability({ config, backends, bindings: Object.values(snapshot.roles) });
        for (const error of [...syntax.errors, ...availability.errors]) console.log(`  error: ${error}`);
        for (const warning of [...syntax.warnings, ...availability.warnings]) console.log(`  warn: ${warning}`);
        if (forceProbe) {
          console.log('Probes:');
          for (const result of await probeAll({ config, backends, bindings: Object.values(snapshot.roles) })) {
            console.log(`  ${result.backend}${result.model ? `/${result.model}` : ''}: ${result.ok ? `ok (${result.latencyMs ?? 0}ms)` : `FAILED${result.error ? ` — ${result.error}` : ''}`}`);
          }
        }
      } finally {
        disposeBackends(backends);
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'plan' || command === 'launch') {
    const goalFile = argv.shift();
    if (!goalFile) throw new Error(`Usage: agent-team ${command} <goal-file> [--run-id ID] [--agent NAME] [-c path=value] [--repo PATH]`);
    const runId = option('--run-id');
    const agent = option('--agent');
    const repoRoot = repoOption();
    const { config, db } = database(repoRoot);
    if (agent) config.defaultAgent = agent;
    try {
      await preflight(config, Object.values(snapshotAgents(config).roles), true);
      const ui = new LiveRunUi(db);
      const approvals = terminalApprovals(config, ui);
      ui.start(runId);
      try {
        const id = await planRun({
          config, db, goalFile, ...(runId ? { runId } : {}),
          requestApproval: approvals.request,
          requestUserInput: approvals.requestUserInput,
          onAgentEvent: ui.onEvent
        });
        ui.setRun(id);
        console.log(`Planned run: ${id}`);
        console.log(formatRunStatus(db.getRun(id), db.listTasks(id)));
        if (command === 'launch') {
          const run = db.getRun(id);
          await preflight(config, bindingsForRun(config, run.rolesJson, run.manifestJson), false);
          await runOrchestrator({
            config, db, runId: id,
            requestApproval: approvals.request,
            requestUserInput: approvals.requestUserInput,
            onAgentEvent: ui.onEvent
          });
        }
      } finally {
        approvals.close();
        ui.stop();
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'run') {
    const runId = argv.shift();
    if (!runId) throw new Error('Usage: agent-team run <run-id> [--repo PATH]');
    const repoRoot = repoOption();
    if (argv.length > 0) throw new Error(`Unknown run option: ${argv[0]}`);
    const { config, db } = database(repoRoot);
    try {
      // -c roles.* 视为对当前 run 的人为强制修改：只更新被覆写的角色，其余保留原快照
      const roleOverrides = configOverrides().filter(({ key }) => key === 'roles' || key.startsWith('roles.'));
      if (roleOverrides.length > 0) {
        const record = db.getRun(runId);
        const base = parseSnapshot(record.rolesJson) ?? snapshotAgents(config);
        const fresh = snapshotAgents(config);
        for (const { key } of roleOverrides) {
          const role = key.split('.')[1] as keyof typeof fresh.roles;
          if (role && role in fresh.roles) base.roles[role] = fresh.roles[role]!;
        }
        db.updateRun(runId, { rolesJson: JSON.stringify(base) });
      }
      const run = db.getRun(runId);
      await preflight(config, bindingsForRun(config, run.rolesJson, run.manifestJson), false);
      const ui = new LiveRunUi(db);
      const approvals = terminalApprovals(config, ui);
      ui.start(runId);
      try {
        await runOrchestrator({
          config, db, runId,
          requestApproval: approvals.request,
          requestUserInput: approvals.requestUserInput,
          onAgentEvent: ui.onEvent
        });
        console.log(formatRunStatus(db.getRun(runId), db.listTasks(runId)));
      } finally {
        approvals.close();
        ui.stop();
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'status') {
    const possibleRunId = argv[0] && !argv[0]!.startsWith('--') ? argv.shift() : undefined;
    const watch = flag('--watch');
    const repoRoot = repoOption();
    const { config, db } = database(repoRoot);
    try {
      const show = (): void => {
        const run = possibleRunId ? db.getRun(possibleRunId) : db.listRuns()[0];
        if (!run) throw new Error('No runs found');
        if (watch) process.stdout.write('\x1Bc');
        console.log(formatRunStatus(run, db.listTasks(run.id)));
      };
      show();
      if (watch) {
        await new Promise<void>((resolvePromise) => {
          const timer = setInterval(show, config.status.pollIntervalMs);
          const stop = (): void => { clearInterval(timer); resolvePromise(); };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'list') {
    const repoRoot = repoOption();
    const { db } = database(repoRoot);
    try {
      for (const run of db.listRuns()) console.log(`${run.id}\t${run.status}\t${run.createdAt}`);
    } finally { db.close(); }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function runAuthCommand(): Promise<void> {
  const subcommand = argv.shift();
  if (subcommand === 'login') {
    const { backend } = authOptions(false);
    throw new Error(`OAuth login is not supported; use the ${backend} native CLI to log in.`);
  }
  if (subcommand !== 'set' && subcommand !== 'status' && subcommand !== 'logout') {
    throw new Error('Usage: agent-team auth <set|status|logout> --backend BACKEND --profile NAME');
  }
  if (subcommand === 'set' && argv.some((argument) => argument === '--key' || argument.startsWith('--key='))) {
    throw new Error('agent-team auth set does not accept --key; enter the API key at the masked terminal prompt.');
  }
  const { backend, profile } = authOptions(true);
  const credentials = createCredentialStore();
  if (subcommand === 'set') {
    const apiKey = await promptMaskedSecret('API key: ');
    if (!apiKey) throw new Error('API key must not be empty.');
    await credentials.setApiKey(backend, profile, apiKey);
    console.log('Credential saved.');
    return;
  }
  if (subcommand === 'status') {
    console.log((await credentials.hasApiKey(backend, profile)) ? 'present' : 'missing');
    return;
  }
  await credentials.deleteApiKey(backend, profile);
  console.log('Credential removed.');
}

async function runLogsCommand(): Promise<void> {
  const runId = argv.shift();
  if (!runId || runId.startsWith('--')) throw new Error('Usage: agent-team logs <run-id> [agent-id] [--list] [--follow] [--repo PATH]');
  const agentId = argv[0] && !argv[0]!.startsWith('--') ? argv.shift() : undefined;
  const list = flag('--list');
  const follow = flag('--follow');
  const repoRoot = repoOption();
  if (list && agentId) throw new Error('agent-team logs --list does not accept an agent ID');
  if (!list && !agentId) throw new Error('agent-team logs requires an agent ID, or use --list');
  if (argv.length > 0) throw new Error(`Unknown logs option: ${argv[0]}`);
  const { db } = database(repoRoot);
  try {
    if (list) {
      for (const entry of db.listAgentExecutions(runId)) {
        console.log(`${entry.agentId}\t${entry.role}\t${entry.backend}${entry.model ? `/${entry.model}` : ''}\t${entry.status}\t${entry.logPath}`);
      }
      return;
    }
    const entry = db.getAgentExecution(runId, agentId!);
    printLog(entry.logPath);
    if (follow) await followLog(entry.logPath);
  } finally {
    db.close();
  }
}

function printLog(path: string): void {
  if (existsSync(path)) process.stdout.write(readFileSync(path, 'utf8'));
}

async function followLog(path: string): Promise<void> {
  let offset = existsSync(path) ? readFileSync(path).length : 0;
  await new Promise<void>((resolvePromise) => {
    const watcher = watch(path, { persistent: true }, () => {
      if (!existsSync(path)) return;
      const content = readFileSync(path, 'utf8');
      if (content.length < offset) offset = 0;
      process.stdout.write(content.slice(offset));
      offset = content.length;
    });
    const stop = (): void => { watcher.close(); resolvePromise(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function authOptions(requireProfile: boolean): { backend: string; profile: string } {
  const backend = option('--backend');
  const profile = option('--profile');
  if (!backend || !isBackendId(backend)) {
    throw new Error('auth --backend must be one of claude, codex, opencode');
  }
  if (requireProfile && (!profile || !isValidAgentName(profile))) {
    throw new Error('auth --profile must use letters, digits, dashes, or underscores (no dots)');
  }
  if (!requireProfile && profile !== undefined) {
    throw new Error('auth login does not accept --profile');
  }
  if (argv.length > 0) throw new Error(`Unknown auth option: ${argv[0]}`);
  return { backend, profile: profile ?? '' };
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  argv = [...args];
  command = argv.shift();
  rawConfigOverrides = [];
  while (true) {
    const index = argv.indexOf('-c');
    if (index < 0) break;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('-c requires a value like roles.lead=codex.terra');
    argv.splice(index, 2);
    rawConfigOverrides.push(value);
  }
  await main();
}

function printHelp(): void {
  console.log(`agent-team-runner

Commands:
  init [repo]                         Initialize config and sync role skills
  doctor [--repo PATH]               Check repository and agent backends
  skills sync [--repo PATH]          Mirror portable skills for Codex/OpenCode/Claude
  auth set --backend ID --profile N  Save an API key in the macOS Keychain
  auth status --backend ID --profile N
                                     Report whether a Keychain credential is present
  auth logout --backend ID --profile N
                                     Delete a Keychain credential
  auth login --backend ID            Use the backend native CLI instead (OAuth unsupported)
  logs <run-id> --list               List Agent execution IDs and log paths
  logs <run-id> <agent-id> [--follow] Show one Agent log, optionally following it
  plan <goal.md> [options]           Ask Lead to create and validate a task DAG
  launch <goal.md> [options]         Plan and run end-to-end
  run <run-id>                       Execute Workers, Reviews, and Integration
  status [run-id] [--watch]          Show live state
  list [--repo PATH]                 List runs

Options:
  --repo PATH
  --run-id ID
  --agent NAME                   Default agent (from the agents registry)
  -c <path>=<value>              Override any config key (repeatable), e.g.
                                     -c roles.lead=lead-agent -c concurrency=5
                                 Priority: -c flags > config.yml > defaults
`);
}

function terminalApprovals(config: RunnerConfig, ui: LiveRunUi): TerminalApprovalBroker {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Planning and running require an interactive terminal for backend permissions and user questions.');
  }
  return new TerminalApprovalBroker(process.stdin, process.stdout, config.interactionAlert, undefined, {
    beforePrompt: ui.pause,
    afterPrompt: ui.resume
  });
}

async function getBackend(
  backends: Record<BackendId, AgentBackend> | BackendPool,
  binding: AgentBinding
): Promise<AgentBackend> {
  if (typeof (backends as Partial<BackendPool>).get === 'function') return await (backends as BackendPool).get(binding);
  return (backends as Record<BackendId, AgentBackend>)[binding.backend]!;
}

export function formatCliError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
  });
}
