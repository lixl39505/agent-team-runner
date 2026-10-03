// agent-team doctor --runtime herdr — fail-fast environment probe with
// actionable remediation (ADR 0001: version/protocol/capability checks).

import { HerdrCliTransport } from '../herdr/cli-transport.ts';
import { HerdrError } from '../herdr/types.ts';
import { detectCapabilities, isVersionAtLeast, MINIMUM_HERDR_VERSION } from '../herdr/versions.ts';
import { AGENT_KINDS } from '../core/types.ts';
import { runArgv } from '../core/shell.ts';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  herdrPath?: string;
  /** Check agent CLIs too (default true). */
  checkAgents?: boolean;
  /** Test seam: argv prefix for the herdr transport. */
  argvPrefix?: readonly string[];
}

async function checkHerdr(herdrPath: string | undefined, argvPrefix?: readonly string[]): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const cli = new HerdrCliTransport(herdrPath, undefined, argvPrefix);

  let version: string;
  try {
    version = await cli.callText(['--version'], { timeoutMs: 10_000 });
    checks.push({ name: 'herdr.version', ok: true, detail: version });
  } catch (err) {
    const code = err instanceof HerdrError ? err.code : 'unknown';
    checks.push({
      name: 'herdr.version',
      ok: false,
      detail: `cannot run herdr${herdrPath ? ` (${herdrPath})` : ''}: ${code}`,
      remediation:
        code === 'herdr_not_found'
          ? 'install Herdr (e.g. `mise use -g bun@latest && bun install -g herdr` or the official installer) or set ATEAM_HERDR_PATH'
          : 'make sure the herdr binary is on PATH and executable',
    });
    return checks;
  }

  if (!isVersionAtLeast(version, MINIMUM_HERDR_VERSION)) {
    checks.push({
      name: 'herdr.version.min',
      ok: false,
      detail: `herdr ${version} < required ${MINIMUM_HERDR_VERSION}`,
      remediation: `upgrade Herdr to >= ${MINIMUM_HERDR_VERSION}`,
    });
  } else {
    checks.push({ name: 'herdr.version.min', ok: true, detail: `>= ${MINIMUM_HERDR_VERSION}` });
  }

  try {
    const schema = await cli.callJson<unknown>(['api', 'schema', '--json'], { timeoutMs: 15_000 });
    const caps = detectCapabilities(schema);
    checks.push({ name: 'herdr.protocol', ok: true, detail: 'api schema parsed' });
    for (const [cap, ok] of Object.entries(caps)) {
      checks.push({
        name: `herdr.capability.${cap}`,
        ok,
        detail: ok ? 'available' : 'missing required socket methods',
        remediation: ok ? undefined : `Herdr is missing the ${cap} capability; upgrade Herdr`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'herdr.protocol',
      ok: false,
      detail: err instanceof HerdrError ? `${err.code}: ${err.message}` : String(err),
      remediation: 'upgrade Herdr so `herdr api schema --json` works',
    });
  }

  return checks;
}

async function checkAgentCli(kind: string): Promise<DoctorCheck> {
  const res = await runArgv([kind, '--version'], { timeoutMs: 10_000 });
  const ok = res.ok;
  return {
    name: `agent.${kind}`,
    ok,
    detail: ok ? (res.stdout.trim().split('\n')[0] ?? kind) : `${kind} CLI not runnable (exit ${res.exitCode})`,
    remediation: ok ? undefined : `install the ${kind} CLI — runs of kind ${kind} will fail-fast without it`,
  };
}

async function checkGit(): Promise<DoctorCheck> {
  const res = await runArgv(['git', '--version'], { timeoutMs: 10_000 });
  return {
    name: 'git',
    ok: res.ok,
    detail: res.ok ? res.stdout.trim() : 'git not runnable',
    remediation: res.ok ? undefined : 'install git (required for delivery gates)',
  };
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(...(await checkHerdr(opts.herdrPath, opts.argvPrefix)));
  if (opts.checkAgents !== false) {
    for (const kind of AGENT_KINDS) {
      checks.push(await checkAgentCli(kind));
    }
  }
  checks.push(await checkGit());
  return { ok: checks.every((c) => c.ok), checks };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    const mark = check.ok ? 'ok  ' : 'FAIL';
    lines.push(`${mark}  ${check.name}: ${check.detail}`);
    if (!check.ok && check.remediation) lines.push(`      fix: ${check.remediation}`);
  }
  lines.push(report.ok ? 'doctor: PASS' : 'doctor: FAIL');
  return lines.join('\n');
}
