#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
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
import { snapshotRoles, validateProfiles } from './core/profiles.js';
import { checkProfileAvailability } from './core/preflight.js';
import type { AdapterName, ResolvedProfile, RunnerConfig } from './core/types.js';

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

async function preflight(config: RunnerConfig, profiles: ResolvedProfile[], validateSyntax: boolean): Promise<void> {
  if (validateSyntax) {
    const syntax = validateProfiles(config);
    if (!syntax.ok) throw new Error(`Invalid agent profile config:\n  - ${syntax.errors.join('\n  - ')}`);
  }
  const availability = await checkProfileAvailability(config, profiles);
  for (const warning of availability.warnings) console.error(`warning: ${warning}`);
  if (!availability.ok) {
    throw new Error(`Agent profile preflight failed:\n  - ${availability.errors.join('\n  - ')}`);
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
    const { config, db } = database(repoRoot);
    try {
      await ensureGitRepo(config.repoRoot);
      console.log(`Node: ${process.version}`);
      console.log(`Repository: ${config.repoRoot}`);
      console.log(`State DB: ${join(config.stateDir, 'state.sqlite')}`);
      for (const [name, adapter] of Object.entries(config.adapters)) {
        const result = await execFile(adapter.command, ['--version'], config.repoRoot).catch((error) => ({ code: 127, stdout: '', stderr: String(error) }));
        console.log(`${name}: ${result.code === 0 ? result.stdout.trim() || 'available' : `unavailable (${result.stderr.trim()})`}`);
      }
      const roles = snapshotRoles(config);
      const syntax = validateProfiles(config);
      const availability = await checkProfileAvailability(config, Object.values(roles));
      console.log('Roles:');
      for (const [role, profile] of Object.entries(roles)) {
        console.log(`  ${role}: ${profile.cli}${profile.model ? ` (${profile.model})` : ''} [${profile.source}]`);
      }
      for (const error of [...syntax.errors, ...availability.errors]) console.log(`  error: ${error}`);
      for (const warning of availability.warnings) console.log(`  warn: ${warning}`);
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'plan' || command === 'launch') {
    const goalFile = argv.shift();
    if (!goalFile) throw new Error(`Usage: agent-team ${command} <goal-file> [--run-id ID] [--adapter claude|codex|opencode] [-c path=value] [--repo PATH]`);
    const runId = option('--run-id');
    const adapter = option('--adapter') as AdapterName | undefined;
    const repoRoot = repoOption();
    const { config, db } = database(repoRoot);
    if (adapter) config.defaultAdapter = adapter;
    try {
      await preflight(config, Object.values(snapshotRoles(config)), true);
      const id = await planRun({ config, db, goalFile, ...(runId ? { runId } : {}), ...(adapter ? { adapter } : {}) });
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
        const base: Record<string, ResolvedProfile> = record.rolesJson
          ? (JSON.parse(record.rolesJson) as Record<string, ResolvedProfile>)
          : snapshotRoles(config);
        const fresh: Record<string, ResolvedProfile> = snapshotRoles(config);
        for (const { key } of roleOverrides) {
          const role = key.split('.')[1];
          if (role && role in fresh) base[role] = fresh[role]!;
        }
        db.updateRun(runId, { rolesJson: JSON.stringify(base) });
      }
      const run = db.getRun(runId);
      const profiles: ResolvedProfile[] = run.rolesJson
        ? Object.values(JSON.parse(run.rolesJson) as Record<string, ResolvedProfile>)
        : Object.values(snapshotRoles(config));
      if (run.manifestJson) {
        const manifest = JSON.parse(run.manifestJson) as { tasks: { adapter?: AdapterName }[] };
        for (const task of manifest.tasks) {
          if (task.adapter && !profiles.some((profile) => profile.cli === task.adapter)) {
            profiles.push({ cli: task.adapter, model: config.adapters[task.adapter].model, source: `task:${task.adapter}` });
          }
        }
      }
      await preflight(config, profiles, false);
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
    const { db } = database(repoRoot);
    try {
      for (const task of db.listTasks(runId)) {
        if (task.pid) {
          try { process.kill(task.pid, 'SIGTERM'); } catch { /* already stopped */ }
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
  doctor [--repo PATH]               Check repository and agent CLIs
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
  --adapter claude|codex|opencode
  -c <path>=<value>              Override any config key (repeatable), e.g.
                                     -c roles.lead=codex.terra -c concurrency=5
                                 Priority: -c flags > config.yml > defaults
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
