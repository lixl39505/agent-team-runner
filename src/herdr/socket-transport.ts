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
   * moment they proceed to a snapshot. */
  async subscribe(filter?: { paneId?: string }, timeoutMs = 15_000): Promise<HerdrEventStream> {
    const socket = await this.connectSocket(timeoutMs);
    const id = `ateam-sub-${++this.seq}`;
    const subscriptions = filter?.paneId
      ? [{ type: 'pane.agent_status_changed', pane_id: filter.paneId }]
      : [{ type: 'pane.agent_status_changed' }, { type: 'pane.closed' }, { type: 'pane.exited' }, { type: 'worktree.removed' }];
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
      let doc: { id?: string; error?: { code?: string; message?: string }; event?: unknown; type?: string; pane_id?: string; workspace_id?: string };
      try {
        doc = JSON.parse(line);
      } catch {
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
      const payload = (doc.event ?? doc) as Record<string, unknown>;
      const event: HerdrEvent = {
        type: String(payload.type ?? 'unknown'),
        paneId: typeof payload.pane_id === 'string' ? payload.pane_id : undefined,
        workspaceId: typeof payload.workspace_id === 'string' ? payload.workspace_id : undefined,
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
