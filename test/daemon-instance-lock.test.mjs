import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentTeamHome } from '../src/core/home.ts';
import { DaemonAlreadyRunningError, DaemonInstanceLock } from '../src/daemon/instance-lock.ts';

function withHome(run) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-team-daemon-lock-'));
  const home = resolveAgentTeamHome({ env: { AGENT_TEAM_HOME: join(parent, 'home') } });
  try {
    run(home);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test('DaemonInstanceLock acquires and releases daemon metadata files', () => {
  withHome((home) => {
    const metadata = { pid: 123, startedAt: '2026-08-30T00:00:00.000Z', protocolVersion: 1 };
    const lock = DaemonInstanceLock.acquire(home, metadata, () => true);
    assert.deepEqual(JSON.parse(readFileSync(home.daemonLock, 'utf8')), metadata);
    assert.deepEqual(JSON.parse(readFileSync(home.daemonInfo, 'utf8')), metadata);

    lock.release();
    assert.equal(existsSync(home.daemonLock), false);
    assert.equal(existsSync(home.daemonInfo), false);
  });
});

test('DaemonInstanceLock reports metadata from an active lock', () => {
  withHome((home) => {
    const metadata = { pid: 456, startedAt: '2026-08-30T00:00:00.000Z', protocolVersion: 2 };
    const active = DaemonInstanceLock.acquire(home, metadata, () => true);
    try {
      assert.throws(
        () => DaemonInstanceLock.acquire(home, undefined, () => true),
        (error) => error instanceof DaemonAlreadyRunningError && error.metadata.pid === metadata.pid
      );
    } finally {
      active.release();
    }
  });
});

test('DaemonInstanceLock replaces stale dead-PID and invalid locks', () => {
  withHome((home) => {
    const stale = { pid: 789, startedAt: '2026-08-30T00:00:00.000Z', protocolVersion: 1 };
    mkdirSync(home.root, { recursive: true });
    writeFileSync(home.daemonLock, JSON.stringify(stale));
    const dead = new DaemonInstanceLock(() => false);
    dead.acquire(home, { pid: 790, startedAt: '2026-08-30T00:01:00.000Z', protocolVersion: 1 });
    dead.release();

    writeFileSync(home.daemonLock, 'not json');
    const invalid = new DaemonInstanceLock(() => true);
    invalid.acquire(home, { pid: 791, startedAt: '2026-08-30T00:02:00.000Z', protocolVersion: 1 });
    invalid.release();
  });
});

test('DaemonInstanceLock treats ENOENT PID checks as stale', () => {
  withHome((home) => {
    mkdirSync(home.root, { recursive: true });
    writeFileSync(home.daemonLock, JSON.stringify({ pid: 800, startedAt: '2026-08-30T00:00:00.000Z', protocolVersion: 1 }));
    const lock = new DaemonInstanceLock(() => {
      const error = new Error('missing process');
      error.code = 'ENOENT';
      throw error;
    });
    lock.acquire(home, { pid: 801, startedAt: '2026-08-30T00:01:00.000Z', protocolVersion: 1 });
    lock.release();
  });
});

test('DaemonInstanceLock uses the default PID check and accepts detector options', () => {
  withHome((home) => {
    const active = DaemonInstanceLock.acquire(home);
    try {
      assert.throws(() => DaemonInstanceLock.acquire(home), DaemonAlreadyRunningError);
    } finally {
      active.release();
    }

    const lock = new DaemonInstanceLock({ isPidAlive: () => false });
    lock.acquire(home);
    lock.release();
    new DaemonInstanceLock().release();

    mkdirSync(home.root, { recursive: true });
    writeFileSync(home.daemonLock, JSON.stringify({ pid: 2_147_483_647, startedAt: '2026-08-30T00:00:00.000Z', protocolVersion: 1 }));
    const stale = DaemonInstanceLock.acquire(home);
    stale.release();
  });
});

test('DaemonInstanceLock validates malformed metadata and keeps replacement files on release', () => {
  withHome((home) => {
    const invalidLocks = [
      'null',
      '[]',
      '{}',
      JSON.stringify({ pid: 1.5, startedAt: 'time', protocolVersion: 1 }),
      JSON.stringify({ pid: 0, startedAt: 'time', protocolVersion: 1 }),
      JSON.stringify({ pid: 1, startedAt: 1, protocolVersion: 1 }),
      JSON.stringify({ pid: 1, startedAt: '', protocolVersion: 1 }),
      JSON.stringify({ pid: 1, startedAt: 'time', protocolVersion: 1.5 }),
      JSON.stringify({ pid: 1, startedAt: 'time', protocolVersion: -1 })
    ];
    mkdirSync(home.root, { recursive: true });
    for (const contents of invalidLocks) {
      writeFileSync(home.daemonLock, contents);
      const lock = new DaemonInstanceLock(() => false);
      lock.acquire(home);
      lock.release();
    }

    const metadata = { pid: 1000, startedAt: '2026-08-30T00:00:00.000Z', protocolVersion: 1 };
    for (const replacement of [
      { ...metadata, pid: 1001 },
      { ...metadata, startedAt: '2026-08-30T00:01:00.000Z' },
      { ...metadata, protocolVersion: 2 }
    ]) {
      const lock = new DaemonInstanceLock(() => false).acquire(home, metadata);
      writeFileSync(home.daemonLock, JSON.stringify(replacement));
      lock.release();
      assert.deepEqual(JSON.parse(readFileSync(home.daemonLock, 'utf8')), replacement);
      rmSync(home.daemonLock);
    }
  });
});

test('DaemonInstanceLock cleans its lock when writing daemon info fails', () => {
  withHome((home) => {
    mkdirSync(home.root, { recursive: true });
    const invalidInfoHome = { ...home, daemonInfo: home.root };
    assert.throws(() => DaemonInstanceLock.acquire(invalidInfoHome, undefined, () => false), /EISDIR|EACCES|EPERM/);
    assert.equal(existsSync(home.daemonLock), false);

    const missingParentHome = { ...home, daemonLock: join(home.root, 'missing', 'daemon.lock') };
    assert.throws(() => DaemonInstanceLock.acquire(missingParentHome), /ENOENT/);
  });
});

test('DaemonInstanceLock rejects invalid acquisition metadata', () => {
  withHome((home) => {
    assert.throws(() => new DaemonInstanceLock().acquire(home, { pid: 1.5 }), /positive integer/);
    assert.throws(() => new DaemonInstanceLock().acquire(home, { pid: -1 }), /positive integer/);
    assert.throws(() => new DaemonInstanceLock().acquire(home, { startedAt: '' }), /startedAt is required/);
    assert.throws(() => new DaemonInstanceLock().acquire(home, { protocolVersion: 1.5 }), /non-negative integer/);
    assert.throws(() => new DaemonInstanceLock().acquire(home, { protocolVersion: -1 }), /non-negative integer/);
  });
});

test('DaemonInstanceLock surfaces unexpected release filesystem errors', () => {
  withHome((home) => {
    const lock = DaemonInstanceLock.acquire(home);
    rmSync(home.daemonLock);
    mkdirSync(home.daemonLock);
    assert.throws(() => lock.release(), /EISDIR|EPERM|illegal operation/i);
  });
});

test('DaemonInstanceLock ignores a lock file already removed before release', () => {
  withHome((home) => {
    const lock = DaemonInstanceLock.acquire(home);
    rmSync(home.daemonLock);
    lock.release();
    assert.equal(existsSync(home.daemonInfo), false);
  });
});

test('DaemonInstanceLock considers PID permission errors active', () => {
  withHome((home) => {
    mkdirSync(home.root, { recursive: true });
    const metadata = { pid: 1100, startedAt: '2026-08-30T00:00:00.000Z', protocolVersion: 1 };
    writeFileSync(home.daemonLock, JSON.stringify(metadata));
    const lock = new DaemonInstanceLock(() => {
      const error = new Error('permission denied');
      error.code = 'EPERM';
      throw error;
    });
    assert.throws(
      () => lock.acquire(home),
      (error) => error instanceof DaemonAlreadyRunningError && error.metadata.pid === metadata.pid
    );
  });
});

test('DaemonInstanceLock rejects repeated acquire and makes release idempotent', () => {
  withHome((home) => {
    const lock = new DaemonInstanceLock(() => true);
    lock.acquire(home, { pid: 900, startedAt: '2026-08-30T00:00:00.000Z', protocolVersion: 1 });
    assert.throws(() => lock.acquire(home), DaemonAlreadyRunningError);
    lock.release();
    lock.release();
    assert.equal(existsSync(home.daemonLock), false);
    assert.equal(existsSync(home.daemonInfo), false);
  });
});
