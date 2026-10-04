// Preflight gates shared by every swarm entry (review 01 #10) + the plugin
// claim/self-pane plumbing (review 01 #7).

import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrRuntimeClient } from '../src/herdr/client.ts';
import type { HerdrProbe } from '../src/herdr/types.ts';
import { probeOrFailFast, resolveSelfPaneId } from '../src/commands/run-shared.ts';
import { cmdRun } from '../src/commands/run.ts';
import { DoctorError } from '../src/core/errors.ts';

const HEALTHY_PROBE: HerdrProbe = {
  version: '0.8.0',
  protocolOk: true,
  transport: 'cli',
  capabilities: { worktree: true, agent: true, sessionSnapshot: true, reportAgent: true, plugin: true },
};

function clientWithProbe(probe: HerdrProbe | Error): HerdrRuntimeClient {
  const probeOnce = async (): Promise<HerdrProbe> => {
    if (probe instanceof Error) throw probe;
    return probe;
  };
  return {
    probe: probeOnce,
    createWorktreeWorkspace: () => Promise.reject(new Error('unused')),
    openWorktree: () => Promise.reject(new Error('unused')),
    removeWorktree: () => Promise.reject(new Error('unused')),
    splitPane: () => Promise.reject(new Error('unused')),
    closePane: () => Promise.reject(new Error('unused')),
    focusPane: () => Promise.reject(new Error('unused')),
    startAgent: () => Promise.reject(new Error('unused')),
    promptAgent: () => Promise.reject(new Error('unused')),
    waitAgent: () => Promise.reject(new Error('unused')),
    getAgent: () => Promise.reject(new Error('unused')),
    readPane: () => Promise.reject(new Error('unused')),
    reportAgentState: () => Promise.reject(new Error('unused')),
    snapshot: () => Promise.reject(new Error('unused')),
    subscribe: () => Promise.reject(new Error('unused')),
  } satisfies HerdrRuntimeClient;
}

describe('probeOrFailFast', () => {
  test('healthy probe passes', async () => {
    await expect(probeOrFailFast(clientWithProbe(HEALTHY_PROBE))).resolves.toBeUndefined();
  });

  test('unparseable version / bad protocol fails even with full capabilities', async () => {
    const probe = { ...HEALTHY_PROBE, version: 'dev-local', protocolOk: false };
    await expect(probeOrFailFast(clientWithProbe(probe))).rejects.toThrow(DoctorError);
    await expect(probeOrFailFast(clientWithProbe(probe))).rejects.toThrow(/minimum protocol/);
  });

  test('missing capabilities fail with their names', async () => {
    const probe = { ...HEALTHY_PROBE, capabilities: { ...HEALTHY_PROBE.capabilities, worktree: false, agent: false } };
    await expect(probeOrFailFast(clientWithProbe(probe))).rejects.toThrow(/missing capabilities: worktree, agent/);
  });

  test('probe transport failure surfaces remediation', async () => {
    const err = await probeOrFailFast(clientWithProbe(new Error('spawn ENOENT'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DoctorError);
    expect((err as DoctorError).remediation).toContain('doctor --runtime herdr');
  });
});

describe('resolveSelfPaneId (plugin context)', () => {
  test('flag wins over env and plugin context', () => {
    process.env.HERDR_PANE_ID = 'env-pane';
    process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ pane_id: 'ctx-pane' });
    expect(resolveSelfPaneId('flag-pane')).toBe('flag-pane');
    expect(resolveSelfPaneId()).toBe('ctx-pane');
    delete process.env.HERDR_PLUGIN_CONTEXT_JSON;
    expect(resolveSelfPaneId()).toBe('env-pane');
  });

  test('plugin action context pane id is honored', () => {
    delete process.env.HERDR_PANE_ID;
    process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ workspace: { paneId: 'ws-pane' } });
    expect(resolveSelfPaneId()).toBe('ws-pane');
    process.env.HERDR_PLUGIN_CONTEXT_JSON = '{not json';
    expect(resolveSelfPaneId()).toBeUndefined();
    delete process.env.HERDR_PLUGIN_CONTEXT_JSON;
  });
});

describe('cmdRun argument gate', () => {
  test('rejects --contract combined with --claim before touching Herdr', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ateam-probe-home-'));
    await expect(cmdRun({ contract: 'x.json', claim: true, home, json: false })).rejects.toThrow(/not both/);
  });

  test('requires one of --contract/--run-id/--claim', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ateam-probe-home-'));
    await expect(cmdRun({ home, json: false })).rejects.toThrow(/requires --contract/);
  });
});
