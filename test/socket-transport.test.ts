// Socket transport tests. Unix-socket based; skipped on Windows where the
// equivalent named-pipe test would need a live Herdr install.

import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { herdrSocketPath, HerdrSocketTransport } from '../src/herdr/socket-transport.ts';

describe('herdrSocketPath', () => {
  test('env override wins', () => {
    process.env.HERDR_SOCKET_PATH = '/custom/sock';
    expect(herdrSocketPath()).toBe('/custom/sock');
    delete process.env.HERDR_SOCKET_PATH;
  });
});

const isWin = process.platform === 'win32';

describe.skipIf(isWin)('HerdrSocketTransport against a local NDJSON server', () => {
  test('request + snapshot + subscribe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ateam-sock-'));
    const sockPath = join(dir, 'herdr.sock');
    let eventsSent = 0;
    const buffers = new Map<unknown, string>();
    const server = Bun.listen({
      unix: sockPath,
      socket: {
        open() {},
        data(socket, chunk) {
          let acc = (buffers.get(socket) ?? '') + chunk.toString('utf8');
          let idx: number;
          while ((idx = acc.indexOf('\n')) >= 0) {
            const line = acc.slice(0, idx);
            acc = acc.slice(idx + 1);
            if (!line.trim()) continue;
            const doc = JSON.parse(line) as { id: string; method: string };
            if (doc.method === 'session.snapshot') {
              socket.write(`${JSON.stringify({ id: doc.id, result: {
                version: '0.8.0',
                workspaces: [{ workspace_id: 'w1', worktree: { branch: 'b', path: '/p' } }],
                tabs: [{ tab_id: 'w1:t', workspace_id: 'w1' }],
                panes: [{ pane_id: 'w1:p', workspace_id: 'w1', tab_id: 'w1:t' }],
                agents: [{ name: 'a', pane_id: 'w1:p', state: 'working' }],
              } })}\n`);
            } else if (doc.method === 'events.subscribe') {
              socket.write(`${JSON.stringify({ id: doc.id, result: { type: 'subscribed' } })}\n`);
              setTimeout(() => {
                socket.write(`${JSON.stringify({ type: 'pane.closed', pane_id: 'w9:p1' })}\n`);
                eventsSent += 1;
              }, 20);
            } else {
              socket.write(`${JSON.stringify({ id: doc.id, result: { type: 'ok' } })}\n`);
            }
          }
          buffers.set(socket, acc);
        },
        close(socket) {
          buffers.delete(socket);
        },
        error() {},
      },
    });
    try {
      const transport = new HerdrSocketTransport(sockPath);
      const snap = (await transport.snapshot()) as { result: { version: string } };
      expect(snap.result.version).toBe('0.8.0');

      const stream = await transport.subscribe();
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value.type).toBe('pane.closed');
      expect(first.value.paneId).toBe('w9:p1');
      stream.close();
      expect(eventsSent).toBe(1);
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test('connect failure → herdr_not_running', async () => {
    const transport = new HerdrSocketTransport(join(tmpdir(), 'no-such-sock-xyz'));
    await expect(transport.snapshot()).rejects.toMatchObject({ code: 'herdr_not_running' });
  });
});
