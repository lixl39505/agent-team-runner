#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { applyOverrides, initConfig, loadConfig } from './core/config.js';
import type { ConfigOverride } from './core/config.js';
import { StateDatabase } from './core/db.js';
import { ensureGitignore, syncSkills } from './core/files.js';
import { planRun } from './core/planner.js';
import { runOrchestrator } from './core/orchestrator.js';
import { formatRunStatus } from './core/status.js';
import { execFile, ensureGitRepo } from './core/git.js';
import { buildBackends, disposeBackends, parseSnapshot, resolveAgentByName, snapshotAgents } from './agent/registry.js';
import { generatedProtocolVersion } from './agent/codex/generated.js';
import { backendCommand, validateAgents } from './core/agent-config.js';
import { checkAgentAvailability, probeAll } from './core/preflight.js';
import { terminateTree } from './core/proctree.js';
import type { AgentBinding, RunnerConfig } from './core/types.js';

const argv = process.argv.slice(2);
const command = argv.shift();

const rawConfigOverrides: string[] = [];
while (true) {
  const index = argv.indexOf('-c');
  if (index < 0) break;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('-c requires a value like roles.lead=codex.terra');
  argv.splice(index, 2);
  rawConfigOverrides.push(value);
}

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
  mkdirSync(config.stateDir, { recursive: true });
  return { config, db: new StateDatabase(join(config.stateDir, 'state.sqlite')) };
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

  if (command === 'doctor') {
    const repoRoot = repoOption();
    const forceProbe = flag('--probe');
    const { config, db } = database(repoRoot);
    try {
      await ensureGitRepo(config.repoRoot);
      console.log(`Node: ${process.version}`);
      console.log(`Repository: ${config.repoRoot}`);
      console.log(`State DB: ${join(config.stateDir, 'state.sqlite')}`);
      const backends = buildBackends(config);
      try {
        console.log('Backends:');
        const generatedCodex = generatedProtocolVersion();
        for (const [name, backend] of Object.entries(backends)) {
          const discovery = await backend.discover();
          const label = discovery.installed
            ? `${discovery.version ?? 'available'}${discovery.authed === false ? ' (not authenticated)' : ''}`
            : `unavailable${discovery.detail ? ` (${discovery.detail})` : ''}`;
          console.log(`  ${name}: ${label}`);
          // 协议类型新鲜度：app-server 协议是 experimental，类型快照必须与实际 CLI 版本一致
          if (name === 'codex' && generatedCodex && discovery.version && discovery.version.trim() !== generatedCodex) {
            console.log(`  warn: codex protocol types were generated for "${generatedCodex}" but installed CLI is "${discovery.version.trim()}"; run: npm run gen:codex && npm run check`);
          }
        }
        const snapshot = snapshotAgents(config);
        const syntax = validateAgents(config);
        console.log('Models:');
        for (const [name, backend] of Object.entries(backends)) {
          try {
            const models = await backend.listModels();
            console.log(`  ${name}: ${models.length} models — ${models.slice(0, 6).map((model) => model.id).join(', ')}${models.length > 6 ? ', …' : ''}`);
          } catch (error) {
            console.log(`  ${name}: enumeration failed (${error instanceof Error ? error.message : String(error)})`);
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
      const id = await planRun({ config, db, goalFile, ...(runId ? { runId } : {}) });
      console.log(`Planned run: ${id}`);
      console.log(formatRunStatus(db.getRun(id), db.listTasks(id)));
      if (command === 'launch') await runOrchestrator({ config, db, runId: id });
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'run') {
    const runId = argv.shift();
    if (!runId) throw new Error('Usage: agent-team run <run-id> [--detach] [--repo PATH]');
    const detach = flag('--detach');
    const foreground = flag('--foreground');
    const repoRoot = repoOption();
    if (detach && !foreground) {
      const config = applyOverrides(loadConfig(repoRoot), configOverrides());
      const logPath = join(config.stateDir, 'runs', runId, 'runner.log');
      mkdirSync(join(config.stateDir, 'runs', runId), { recursive: true });
      const cliPath = fileURLToPath(import.meta.url);
      const forwarded = rawConfigOverrides.flatMap((entry) => ['-c', entry]);
      const child = spawn(process.execPath, [cliPath, 'run', runId, '--foreground', '--repo', repoRoot, ...forwarded], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: process.env
      });
      child.unref();
      appendFileSync(logPath, `Detached runner pid=${child.pid}\n`, 'utf8');
      console.log(`Runner started in background. PID: ${child.pid}`);
      console.log(`Status: agent-team status ${runId} --watch --repo ${repoRoot}`);
      return;
    }
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
      const snapshot = parseSnapshot(run.rolesJson) ?? snapshotAgents(config);
      const bindings: AgentBinding[] = [...Object.values(snapshot.roles)];
      if (run.manifestJson) {
        const manifest = JSON.parse(run.manifestJson) as { tasks: { agent?: string }[] };
        for (const task of manifest.tasks) {
          if (!task.agent || bindings.some((binding) => binding.agent === task.agent)) continue;
          bindings.push(resolveAgentByName(task.agent, config, snapshot.agents));
        }
      }
      await preflight(config, bindings, false);
      await runOrchestrator({ config, db, runId });
      console.log(formatRunStatus(db.getRun(runId), db.listTasks(runId)));
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
          const timer = setInterval(show, config.pollIntervalMs);
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

  if (command === 'stop') {
    const runId = argv.shift();
    if (!runId) throw new Error('Usage: agent-team stop <run-id> [--repo PATH]');
    const repoRoot = repoOption();
    const { config, db } = database(repoRoot);
    try {
      // SDK 后端的会话没有 per-task pid；杀掉 detached runner 进程，
      // 其信号处理器会释放共享后端子进程（app-server / opencode serve）
      const runnerLog = join(config.stateDir, 'runs', runId, 'runner.log');
      try {
        const log = readFileSync(runnerLog, 'utf8');
        const match = log.match(/Detached runner pid=(\d+)/);
        if (match) terminateTree(Number(match[1]), true);
      } catch { /* 无 detach 日志 = 前台运行，无需杀 runner */ }
      for (const task of db.listTasks(runId)) {
        if (task.pid) {
          // 兼容仍有 pid 记录的旧 run：杀整个进程组
          terminateTree(task.pid, true);
        }
        if (['running', 'verifying', 'reviewing'].includes(task.status)) {
          db.updateTask(runId, task.taskId, { pid: null, status: 'changes_requested', phase: 'stopped', lastError: 'Stopped by user.' });
        }
      }
      db.updateRun(runId, { status: 'stopped', error: 'Stopped by user.' });
      console.log(`Stopped run ${runId}`);
    } finally { db.close(); }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp(): void {
  console.log(`agent-team-runner

Commands:
  init [repo]                         Initialize config and sync role skills
  doctor [--repo PATH]               Check repository and agent backends
  skills sync [--repo PATH]          Mirror portable skills for Codex/OpenCode/Claude
  plan <goal.md> [options]           Ask Lead to create and validate a task DAG
  launch <goal.md> [options]         Plan and run end-to-end
  run <run-id> [--detach]            Execute Workers, Reviews, and Integration
  status [run-id] [--watch]          Show live state
  list [--repo PATH]                 List runs
  stop <run-id> [--repo PATH]        Stop active agent processes

Options:
  --repo PATH
  --run-id ID
  --agent NAME                   Default agent (from the agents registry)
  -c <path>=<value>              Override any config key (repeatable), e.g.
                                     -c roles.lead=lead-agent -c concurrency=5
                                 Priority: -c flags > config.yml > defaults
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
