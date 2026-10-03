#!/usr/bin/env bun
// agent-team CLI entry. Subcommands land milestone by milestone; this file
// owns dispatch, global flags and the mechanical exit-code protocol.

import { AteamError, exitCodeOf } from './core/errors.ts';
import { renderDoctorReport, runDoctor } from './commands/doctor.ts';
import { cmdRun, type RunCommandOptions } from './commands/run.ts';
import { cmdSubmit } from './commands/submit.ts';
import { cmdRunnerEntry } from './commands/runner-entry.ts';
import { cmdContract } from './commands/contract-cmd.ts';
import { renderStatus, renderLog, snapshot, attachTargets } from './commands/status.ts';
import { openDatabase } from './store/db.ts';
import { loadHome } from './config.ts';

interface GlobalFlags {
  home?: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): { command: string | null; positional: string[]; flags: Record<string, string | boolean> } {
  const command = argv[0] ?? null;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
        flags[arg.slice(2)] = argv[i + 1]!;
        i += 1;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
    i += 1;
  }
  return { command, positional, flags };
}

function globalFlags(flags: Record<string, string | boolean>): GlobalFlags {
  return {
    home: typeof flags.home === 'string' ? flags.home : undefined,
    json: flags.json === true,
  };
}

function usage(): string {
  return [
    'agent-team — Herdr-native delivery control plane',
    '',
    'Usage:',
    '  agent-team run --contract PATH [--run-id ID] [--max-parallel N] [--json]',
    '  agent-team submit --contract PATH [--json]',
    '  agent-team runner (--run-id ID | --claim) [--self-pane PANE_ID]',
    '  agent-team doctor --runtime herdr [--json]',
    '  agent-team status [RUN_ID] [--json]',
    '  agent-team log RUN_ID [--task ID] [--events] [--lines N]',
    '  agent-team attach RUN_ID TASK_ID',
    '  agent-team contract (validate --contract PATH | revise --run-id ID --contract PATH)',
    '  agent-team reconcile [--run-id ID] [--dry-run]   (M5)',
    '  agent-team clean RUN_ID                          (M4)',
    '',
    'Global flags: --home PATH (default ~/.agent-team), --json',
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  const globals = globalFlags(flags);

  switch (command) {
    case null:
    case 'help':
    case '--help':
      console.log(usage());
      return 0;

    case 'doctor': {
      if (flags.runtime !== 'herdr') {
        console.error('doctor requires --runtime herdr');
        return 1;
      }
      const report = await runDoctor({ herdrPath: typeof flags.herdr === 'string' ? flags.herdr : undefined });
      if (globals.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderDoctorReport(report));
      }
      return report.ok ? 0 : 1;
    }

    case 'run': {
      const opts: RunCommandOptions = {
        contract: typeof flags.contract === 'string' ? flags.contract : undefined,
        runId: typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined,
        home: globals.home,
        maxParallel: typeof flags['max-parallel'] === 'string' ? Number(flags['max-parallel']) : undefined,
        json: globals.json,
        herdrPath: typeof flags.herdr === 'string' ? flags.herdr : undefined,
        claim: flags.claim === true,
      };
      return await cmdRun(opts);
    }

    case 'submit': {
      if (typeof flags.contract !== 'string') {
        console.error('submit requires --contract PATH');
        return 1;
      }
      return await cmdSubmit({ contract: flags.contract, home: globals.home, json: globals.json });
    }

    case 'runner': {
      return await cmdRunnerEntry({
        runId: typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined,
        claim: flags.claim === true,
        home: globals.home,
        herdrPath: typeof flags.herdr === 'string' ? flags.herdr : undefined,
      });
    }

    case 'contract': {
      const action = positional[0];
      if (action !== 'validate' && action !== 'revise') {
        console.error('contract requires action: validate | revise');
        return 1;
      }
      if (typeof flags.contract !== 'string') {
        console.error('contract requires --contract PATH');
        return 1;
      }
      return await cmdContract({
        action,
        contract: flags.contract,
        runId: typeof flags['run-id'] === 'string' ? flags['run-id'] : undefined,
        home: globals.home,
        json: globals.json,
      });
    }

    case 'status': {
      const home = await loadHome(globals.home);
      const db = openDatabase(home.dbPath);
      try {
        let runId = positional[0];
        if (!runId) {
          const { listRuns } = await import('./store/runs.ts');
          runId = listRuns(db, { nonTerminalOnly: true })[0]?.id ?? listRuns(db)[0]?.id;
        }
        if (!runId) {
          console.error('no runs found; submit a contract first');
          return 1;
        }
        const snap = snapshot(db, runId);
        if (globals.json) {
          console.log(JSON.stringify(snap, null, 2));
        } else {
          console.log(renderStatus(snap));
        }
        return 0;
      } finally {
        db.close();
      }
    }

    case 'log': {
      const runId = positional[0];
      if (!runId) {
        console.error('log requires RUN_ID');
        return 1;
      }
      const home = await loadHome(globals.home);
      const db = openDatabase(home.dbPath);
      try {
        console.log(renderLog(db, runId, {
          taskId: typeof flags.task === 'string' ? flags.task : undefined,
          limit: typeof flags.lines === 'string' ? Number(flags.lines) : undefined,
        }));
        return 0;
      } finally {
        db.close();
      }
    }

    case 'attach': {
      const [runId, taskId] = positional;
      if (!runId || !taskId) {
        console.error('attach requires RUN_ID TASK_ID');
        return 1;
      }
      const home = await loadHome(globals.home);
      const db = openDatabase(home.dbPath);
      try {
        const targets = attachTargets(db, runId).filter((t) => t.taskId === taskId);
        if (targets.length === 0) {
          console.error(`no attachable pane for task ${taskId} (only retained/open panes qualify)`);
          return 1;
        }
        console.log(`herdr focus ${targets[targets.length - 1]!.paneId}`);
        return 0;
      } finally {
        db.close();
      }
    }

    case 'reconcile':
    case 'clean':
      console.error(`\`${command}\` is not implemented yet (planned milestone M4/M5).`);
      return 1;

    case 'results':
      console.error('`results` is not implemented yet.');
      return 1;

    default:
      console.error(`unknown command: ${command}\n\n${usage()}`);
      return 1;
  }
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
  main(Bun.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof AteamError) {
        console.error(`${err.message}${err.remediation ? `\nfix: ${err.remediation}` : ''}`);
      } else {
        console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      }
      process.exit(exitCodeOf(err));
    });
}
