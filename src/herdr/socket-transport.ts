// Raw NDJSON socket transport (Unix socket / Windows named pipe). Only two
// operations need it: events.subscribe (long-lived stream) and
// session.snapshot (atomic subscribe-then-snapshot recovery). Everything
// else stays on the portable CLI wrapper (ADR 0001).

import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HerdrError, type HerdrEvent, type HerdrEventStream } from './types.ts';

export function herdrSocketPath(): string {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_SESSION) {
    return join(homedir(), '.config', 'herdr', 'sessions', process.env.HERDR_SESSION, 'herdr.sock');
  }
  if (process.platform === 'win32') {
    // Herdr's Windows named pipe; override with HERDR_SOCKET_PATH when needed
    return process.env.ATEAM_HERDR_PIPE ?? '\\\\.\\pipe\\herdr';
  }
  return join(homedir(), '.config', 'herdr', 'herdr.sock');
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: HerdrError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HerdrSocketTransport {
  private seq = 0;

  constructor(readonly socketPath: string = herdrSocketPath()) {}

  private async connectSocket(timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HerdrError('herdr_not_running', `connect timeout on ${this.socketPath}`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new HerdrError('herdr_not_running', `cannot connect to ${this.socketPath}: ${err.message}`));
      });
    });
  }

  /** One request, one response line. */
  async request<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    const socket = await this.connectSocket(timeoutMs);
    try {
      return await new Promise<T>((resolve, reject) => {
        let buffer = '';
        const id = `ateam-${++this.seq}`;
        const timer = setTimeout(() => {
          cleanup();
          reject(new HerdrError('timeout', `${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onLine = (line: string): void => {
          if (!line.trim()) return;
          let doc: { id?: string; result?: unknown; error?: { code?: string; message?: string } };
          try {
            doc = JSON.parse(line);
          } catch {
            return; // not for us
          }
          if (doc.id !== id) return;
          cleanup();
          if (doc.error) {
            reject(new HerdrError('herdr_error', doc.error.message ?? doc.error.code ?? method, doc.error));
          } else {
            resolve(doc.result as T);
          }
        };
        const onData = (chunk: Buffer): void => {
          buffer += chunk.toString('utf8');
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            onLine(line);
          }
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          socket.off('data', onData);
        };
        socket.on('data', onData);
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    } finally {
      socket.destroy();
    }
  }

  async snapshot(timeoutMs = 15_000): Promise<unknown> {
    return this.request('session.snapshot', {}, timeoutMs);
  }

  /** Long-lived event stream over a dedicated socket. The subscription is
   * CONFIRMED before this resolves (review 02 R2-07): the method waits for
   * the server's ack (or error) so callers can rely on "subscribed" the
   * moment they proceed to a snapshot.
   *
   * herdr 0.9.x (protocol 22) only admits pane-scoped subscriptions — every
   * entry REQUIRES a pane_id and a global subscription is rejected with
   * invalid_request (errors also carry an empty id, which would silently
   * never match our ack — treated as a refusal below). Callers pass the
   * panes they actually track. worktree.* types are accepted alongside pane
   * types (真机 0.9.1 验证：混合订阅正常 ack，worktree 事件按 repo 上下文投递
   * 到已有 pane 订阅), and only ONE events.subscribe per connection takes
   * effect — later ones are silently dropped. */
  async subscribe(filter?: { paneId?: string; paneIds?: string[] }, timeoutMs = 15_000): Promise<HerdrEventStream> {
    const panes = filter?.paneId ? [filter.paneId] : (filter?.paneIds ?? []);
    if (panes.length === 0) {
      throw new HerdrError('invalid_request', 'herdr 0.9.x requires pane-scoped event subscriptions (paneIds)');
    }
    const socket = await this.connectSocket(timeoutMs);
    const id = `ateam-sub-${++this.seq}`;
    const types = [
      'pane.agent_status_changed',
      'pane.closed',
      'pane.exited',
      'worktree.created',
      'worktree.removed',
    ];
    const subscriptions = panes.flatMap((p) => types.map((type) => ({ type, pane_id: p })));
    socket.write(`${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } })}\n`);

    let buffer = '';
    let settled = false;
    let onAck: (() => void) | null = null;
    let onFail: ((err: HerdrError) => void) | null = null;
    const ackOrFailure = new Promise<void>((resolve, reject) => {
      onAck = () => {
        settled = true;
        clearTimeout(ackTimer);
        resolve();
      };
      onFail = (err) => {
        settled = true;
        clearTimeout(ackTimer);
        socket.destroy();
        reject(err);
      };
      const ackTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new HerdrError('timeout', `events.subscribe not acknowledged within ${timeoutMs}ms`));
      }, timeoutMs);
    });
    socket.once('error', (err) => {
      onFail?.(new HerdrError('herdr_not_running', err.message));
    });

    const queue: HerdrEvent[] = [];
    let waiter: ((event: HerdrEvent) => void) | null = null;

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let doc: { id?: string | null; error?: { code?: string; message?: string }; event?: string; data?: Record<string, unknown>; type?: string; pane_id?: string; workspace_id?: string };
      try {
        doc = JSON.parse(line);
      } catch {
        return;
      }
      // herdr 0.9.x refuses subscriptions with an error envelope whose id is
      // EMPTY ("" — it can never match our request id). One subscribe per
      // connection, so an unattributed error can only be our refusal;
      // surface it now instead of burning the full ack timeout.
      if (doc.error && (doc.id === undefined || doc.id === null || doc.id === '')) {
        onFail?.(new HerdrError('herdr_error', doc.error.message ?? doc.error.code ?? 'events.subscribe', doc.error));
        return;
      }
      if (doc.id === id) {
        // the subscribe response itself: an error document is a REFUSED
        // subscription, not a silent fallback to polling (R2-07)
        if (doc.error) {
          onFail?.(new HerdrError('herdr_error', doc.error.message ?? doc.error.code ?? 'events.subscribe', doc.error));
          return;
        }
        onAck?.();
        return;
      }
      // 真机 0.9.1 wire shape（2026-10-09 探针实测）：载荷在 `data` 里，类型名
      // 有两种写法 —— `event` 字段（pane.agent_status_changed 点号 /
      // pane_closed 下划线）或 `data.type`（worktree_removed 下划线，无
      // `event` 时兜底）。归一到 API 的点号名：无点的先取第一个下划线。
      const payload = (doc.data && typeof doc.data === 'object' ? doc.data : doc) as Record<string, unknown>;
      let type = String(doc.event ?? payload.type ?? 'unknown');
      if (!type.includes('.')) type = type.replace('_', '.');
      // workspace_id sits at data top level for most events, but
      // worktree.created nests it (data.workspace.workspace_id with
      // data.worktree.open_workspace_id as a fallback)
      const nested = (payload.workspace ?? payload.worktree ?? null) as Record<string, unknown> | null;
      const wsId = [payload.workspace_id, nested?.workspace_id, nested?.open_workspace_id]
        .find((v): v is string => typeof v === 'string' && v.length > 0);
      const event: HerdrEvent = {
        type,
        paneId: typeof payload.pane_id === 'string' ? payload.pane_id : undefined,
        workspaceId: wsId,
        payload,
      };
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(event);
      } else {
        queue.push(event);
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    });

    // R2-07: do not return a stream whose subscription may still be pending
    // — the caller's next observation (snapshot) must be strictly AFTER the
    // confirmed subscription
    await ackOrFailure;

    return {
      async *[Symbol.asyncIterator](): AsyncIterator<HerdrEvent> {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          yield await new Promise<HerdrEvent>((resolve) => {
            waiter = resolve;
          });
        }
      },
      drainPending(): HerdrEvent[] {
        return queue.splice(0, queue.length);
      },
      close(): void {
        socket.destroy();
      },
    };
  }
}
