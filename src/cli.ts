#!/usr/bin/env bun
// agent-team CLI entry. Subcommands land milestone by milestone; this file
// owns dispatch, global flags and the mechanical exit-code protocol.

import { AteamError, exitCodeOf } from './core/errors.ts';
import { renderDoctorReport, runDoctor } from './commands/doctor.ts';

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
    '  agent-team doctor --runtime herdr [--json] [--home PATH]',
    '',
    'More subcommands arrive with later milestones (run/submit/runner/status/...).',
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

    case 'status':
    case 'run':
    case 'submit':
    case 'runner':
    case 'reconcile':
    case 'clean':
    case 'contract':
    case 'log':
    case 'results':
    case 'attach':
      console.error(`\`${command}\` is not implemented yet (planned milestone).`);
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
