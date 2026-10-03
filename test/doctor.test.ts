import { afterAll, describe, expect, test } from 'bun:test';
import { runDoctor } from '../src/commands/doctor.ts';
import { FAKE_HERDR_FIXTURE, clearHerdrControl, setHerdrControl } from './helpers.ts';

afterAll(async () => {
  await clearHerdrControl();
});

const PREFIX = [process.execPath] as const;

describe('runDoctor', () => {
  test('passes against healthy fake herdr', async () => {
    await setHerdrControl({});
    const report = await runDoctor({ herdrPath: FAKE_HERDR_FIXTURE, argvPrefix: PREFIX });
    // agent CLI checks may legitimately fail on machines missing claude/codex/opencode;
    // assert on herdr-specific checks instead of the overall flag.
    const herdrChecks = report.checks.filter((c) => c.name.startsWith('herdr.'));
    expect(herdrChecks.length).toBeGreaterThan(3);
    expect(herdrChecks.every((c) => c.ok)).toBe(true);
    expect(report.checks.some((c) => c.name === 'git')).toBe(true);
  });

  test('fails with remediation when herdr is missing', async () => {
    await clearHerdrControl();
    const report = await runDoctor({
      herdrPath: process.platform === 'win32' ? 'Z:/no/such/herdr.exe' : '/no/such/herdr',
      checkAgents: false,
    });
    expect(report.ok).toBe(false);
    const versionCheck = report.checks.find((c) => c.name === 'herdr.version')!;
    expect(versionCheck.ok).toBe(false);
    expect(versionCheck.remediation).toBeDefined();
  });

  test('flags version below minimum', async () => {
    await setHerdrControl({ version: 'herdr 0.1.0-ancient' });
    const report = await runDoctor({ herdrPath: FAKE_HERDR_FIXTURE, checkAgents: false, argvPrefix: PREFIX });
    const minCheck = report.checks.find((c) => c.name === 'herdr.version.min')!;
    expect(minCheck.ok).toBe(false);
    expect(minCheck.remediation).toContain('upgrade');
  });

  test('temp dir helper sanity', async () => {
    const { cleanupTempDir, makeTempDir } = await import('./helpers.ts');
    const dir = await makeTempDir('ateam-doctor-');
    expect(dir).toContain('ateam-doctor-');
    await cleanupTempDir(dir);
  });
});
