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
  test('request + snapshot + subscribe (ack-confirmed, buffered events drainable)', async () => {
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
              // ACK is DELAYED: subscribe() must not resolve before it
              setTimeout(() => {
                socket.write(`${JSON.stringify({ id: doc.id, result: { type: 'subscribed' } })}\n`);
                // events pushed right after the ack — they must be buffered
                // and visible via drainPending/iteration (R2-07)
                setTimeout(() => {
                  socket.write(`${JSON.stringify({ type: 'pane.closed', pane_id: 'w9:p1' })}\n`);
                  eventsSent += 1;
                }, 20);
              }, 50);
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
      // request() already unwraps the NDJSON envelope: snapshot() IS the result body
      const snap = (await transport.snapshot()) as { version: string; panes: unknown[] };
      expect(snap.version).toBe('0.8.0');
      expect(snap.panes).toHaveLength(1);

      const t0 = Date.now();
      const stream = await transport.subscribe({ paneIds: ['w9:p1'] });
      // the ack was delayed ~50ms — subscribe() waited for it (R2-07)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
      // events pushed after the ack are buffered and retrievable without
      // blocking on the iterator. Wait on the CLIENT-side observable: the
      // server's socket.write() only enqueues bytes, so eventsSent===1 does
      // not mean this process has parsed the event yet — polling on the
      // server counter drained too early under load (the old flake).
      const deadline = Date.now() + 2000;
      let buffered = stream.drainPending!();
      while (buffered.length === 0 && Date.now() < deadline) {
        await Bun.sleep(5);
        buffered = stream.drainPending!();
      }
      expect(eventsSent).toBe(1);
      expect(buffered).toHaveLength(1);
      expect(buffered[0]!.type).toBe('pane.closed');
      expect(buffered[0]!.paneId).toBe('w9:p1');
      expect(stream.drainPending!()).toHaveLength(0); // drained
      stream.close();
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test('subscribe error response rejects instead of degrading (R2-07)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ateam-sock-err-'));
    const sockPath = join(dir, 'herdr.sock');
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
            if (doc.method === 'events.subscribe') {
              socket.write(`${JSON.stringify({ id: doc.id, error: { code: 'unsupported', message: 'no events here' } })}\n`);
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
      await expect(transport.subscribe({ paneIds: ['w9:p1'] })).rejects.toMatchObject({ code: 'herdr_error' });
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test('real herdr 0.9.x wire shapes normalize: data envelope, mixed underscore/dotted type names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ateam-sock-wire-'));
    const sockPath = join(dir, 'herdr.sock');
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
            if (doc.method === 'events.subscribe') {
              // 真机 0.9.1 的确切 wire 行（2026-10-09 探针实录）：
              socket.write(`${JSON.stringify({ id: doc.id, result: { type: 'subscribed' } })}\n`);
              // dotted name in `event`, payload in `data`
              socket.write(`${JSON.stringify({ data: { agent: 'a', agent_status: 'working', pane_id: 'w9:p1', workspace_id: 'w9' }, event: 'pane.agent_status_changed' })}\n`);
              // underscored name in BOTH `event` and `data.type`
              socket.write(`${JSON.stringify({ data: { pane_id: 'w9:p1', type: 'pane_closed', workspace_id: 'w9' }, event: 'pane_closed' })}\n`);
              // worktree event: workspace-scoped payload (no pane_id)
              socket.write(`${JSON.stringify({ data: { forced: true, type: 'worktree_removed', workspace_id: 'w9' }, event: 'worktree_removed' })}\n`);
              // no `event` field at all — data.type is the only carrier
              socket.write(`${JSON.stringify({ data: { type: 'worktree_created', workspace_id: 'w9' } })}\n`);
              // legacy top-level shape stays parseable
              socket.write(`${JSON.stringify({ type: 'pane.exited', pane_id: 'w9:p1' })}\n`);
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
      const stream = await transport.subscribe({ paneIds: ['w9:p1'] });
      const deadline = Date.now() + 2000;
      let buffered = stream.drainPending!();
      while (buffered.length < 5 && Date.now() < deadline) {
        await Bun.sleep(5);
        buffered = stream.drainPending!();
      }
      stream.close();
      expect(buffered.map((e) => e.type)).toEqual([
        'pane.agent_status_changed', // dotted event name kept as-is
        'pane.closed', // pane_closed → pane.closed
        'worktree.removed', // worktree_removed → worktree.removed
        'worktree.created', // data.type fallback
        'pane.exited', // legacy top-level shape
      ]);
      const status = buffered[0]!;
      expect(status.paneId).toBe('w9:p1');
      expect(status.workspaceId).toBe('w9');
      const removed = buffered[2]!;
      expect(removed.workspaceId).toBe('w9'); // reconcile's observedIds deletion keys on this
      expect(removed.paneId).toBeUndefined(); // worktree events carry no pane_id
      expect(removed.payload).toMatchObject({ forced: true });
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test('an empty-id error envelope (refused subscription on 0.9.x) rejects fast instead of timing out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ateam-sock-err2-'));
    const sockPath = join(dir, 'herdr.sock');
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
            if (doc.method === 'events.subscribe') {
              // 真机实测：拒绝订阅的错误信封 id 为 ""，永远匹配不上请求 id
              socket.write(`${JSON.stringify({ id: '', error: { code: 'invalid_request', message: 'global subscriptions are not supported' } })}\n`);
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
      const t0 = Date.now();
      await expect(transport.subscribe({ paneIds: ['w9:p1'] }, 15_000)).rejects.toMatchObject({
        code: 'herdr_error',
        message: 'global subscriptions are not supported',
      });
      expect(Date.now() - t0).toBeLessThan(5000); // fast refusal, not the 15s ack timeout
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test('connect failure → herdr_not_running', async () => {
    const transport = new HerdrSocketTransport(join(tmpdir(), 'no-such-sock-xyz'));
    await expect(transport.snapshot()).rejects.toMatchObject({ code: 'herdr_not_running' });
  });
});
