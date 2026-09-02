import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';

const configWriteRace = vi.hoisted(() => ({ active: false, code: 'EEXIST', parseFailure: false, path: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFileSync(path, ...args) {
      if (configWriteRace.active && path === configWriteRace.path) {
        if (configWriteRace.code === 'EEXIST') actual.writeFileSync(path, ...args);
        const error = Object.assign(new Error('config was created concurrently'), { code: configWriteRace.code });
        throw error;
      }
      return actual.writeFileSync(path, ...args);
    }
  };
});

vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parse(value) {
      if (configWriteRace.parseFailure) throw 'non-Error YAML failure';
      return actual.parse(value);
    }
  };
});
import {
  daemonBootstrapConfigPath,
  ensureDaemonBootstrapConfig,
  loadDaemonBootstrapConfig
} from '../src/core/daemon-config.ts';
import { ensureAgentTeamHome, resolveAgentTeamHome } from '../src/core/home.ts';

function withHome(run) {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-daemon-config-'));
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(root, 'home') } });
  try {
    run(home);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('home initialization creates a default daemon bootstrap config without overwriting it', () => {
  withHome((home) => {
    const path = daemonBootstrapConfigPath(home.root);
    ensureAgentTeamHome(home);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadDaemonBootstrapConfig(home.root), {
      version: 1,
      concurrency: { maxActiveRuns: 3 },
      logs: { retentionDays: 30 },
      tui: { color: 'auto' }
    });

    const custom = `version: 1
concurrency:
  maxActiveRuns: 1
logs:
  retentionDays: 7
tui:
  color: never
`;
    writeFileSync(path, custom, 'utf8');
    ensureAgentTeamHome(home);
    assert.equal(readFileSync(path, 'utf8'), custom);
  });
});

test('daemon bootstrap config tolerates a concurrent default config creation', () => {
  withHome((home) => {
    mkdirSync(home.root, { recursive: true });
    const path = daemonBootstrapConfigPath(home.root);
    configWriteRace.path = path;
    configWriteRace.active = true;
    try {
      assert.equal(ensureDaemonBootstrapConfig(home.root), path);
    } finally {
      configWriteRace.active = false;
      configWriteRace.path = '';
    }
    assert.equal(existsSync(path), true);
  });
});

test('daemon bootstrap config propagates non-race writes and formats non-Error parse failures', () => {
  withHome((home) => {
    mkdirSync(home.root, { recursive: true });
    const path = daemonBootstrapConfigPath(home.root);
    configWriteRace.path = path;
    configWriteRace.code = 'EACCES';
    configWriteRace.active = true;
    try {
      assert.throws(() => ensureDaemonBootstrapConfig(home.root), /config was created concurrently/);
    } finally {
      configWriteRace.active = false;
      configWriteRace.code = 'EEXIST';
      configWriteRace.path = '';
    }

    writeFileSync(path, 'version: 1\n', 'utf8');
    configWriteRace.parseFailure = true;
    try {
      assert.throws(() => loadDaemonBootstrapConfig(home.root), /non-Error YAML failure/);
    } finally {
      configWriteRace.parseFailure = false;
    }
  });
});

test('daemon bootstrap config rejects unknown fields and invalid value types', () => {
  withHome((home) => {
    ensureAgentTeamHome(home);
    const path = daemonBootstrapConfigPath(home.root);
    for (const [config, expected] of [
      ['version: 1\nunknown: true\nconcurrency: { maxActiveRuns: 1 }\nlogs: { retentionDays: 1 }\ntui: { color: auto }\n', /unknown field/],
      ['version: 1\nconcurrency: { maxActiveRuns: one }\nlogs: { retentionDays: 1 }\ntui: { color: auto }\n', /positive integer/],
      ['version: 1\nconcurrency: { maxActiveRuns: 1 }\nlogs: { retentionDays: -1 }\ntui: { color: auto }\n', /non-negative integer/],
      ['version: 1\nconcurrency: { maxActiveRuns: 1 }\nlogs: { retentionDays: 1 }\ntui: { color: blue }\n', /tui.color/],
      ['version: 2\nconcurrency: { maxActiveRuns: 1 }\nlogs: { retentionDays: 1 }\ntui: { color: auto }\n', /version must be 1/]
    ]) {
      writeFileSync(path, config, 'utf8');
      assert.throws(() => loadDaemonBootstrapConfig(home.root), expected);
    }
  });
});

test('daemon bootstrap config returns isolated defaults and rejects malformed mappings', () => {
  withHome((home) => {
    const first = loadDaemonBootstrapConfig(home.root);
    first.concurrency.maxActiveRuns = 99;
    assert.equal(loadDaemonBootstrapConfig(home.root).concurrency.maxActiveRuns, 3);

    ensureAgentTeamHome(home);
    const path = daemonBootstrapConfigPath(home.root);
    for (const [config, expected] of [
      ['concurrency: [1]\n', /config.version must be 1/],
      ['version: 1\nconcurrency: nope\nlogs: { retentionDays: 1 }\ntui: { color: auto }\n', /config.concurrency must be a mapping/],
      ['version: 1\nconcurrency: { maxActiveRuns: 1 }\nlogs: []\ntui: { color: auto }\n', /config.logs must be a mapping/],
      ['version: 1\nconcurrency: { maxActiveRuns: 1 }\nlogs: { retentionDays: 1 }\ntui: false\n', /config.tui must be a mapping/],
      ['version: 1\nconcurrency: { maxActiveRuns: 1 }\nlogs: { retentionDays: 1 }\ntui: { color: auto\n', /Invalid daemon config/]
    ]) {
      writeFileSync(path, config, 'utf8');
      assert.throws(() => loadDaemonBootstrapConfig(home.root), expected);
    }

    rmSync(path, { force: true });
    mkdirSync(path);
    assert.equal(daemonBootstrapConfigPath(home.root), path);
    assert.throws(() => loadDaemonBootstrapConfig(home.root), /EISDIR/);
  });
});
