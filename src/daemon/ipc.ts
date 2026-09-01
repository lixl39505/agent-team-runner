import { chmod, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

export type LocalIpcHandler = (params: unknown) => Promise<unknown>;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function isNamedPipe(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\');
}

async function removeSocket(path: string): Promise<void> {
  // Named pipes are kernel objects, not filesystem entries.
  /* istanbul ignore next -- exercised on Windows */
  if (isNamedPipe(path)) return;
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeFrame(socket: Socket, message: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

/** A newline-delimited JSON request server over a local Unix socket or Windows named pipe. */
export class LocalIpcServer {
  private readonly handlers = new Map<string, LocalIpcHandler>();
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private path: string | undefined;

  register(method: string, handler: LocalIpcHandler): void {
    this.handlers.set(method, handler);
  }

  async start(path: string): Promise<void> {
    if (this.server) throw new Error('IPC server is already running');
    await removeSocket(path);

    const server = createServer((socket) => this.handleConnection(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(path, () => {
          server.off('error', onError);
          resolve();
        });
      });
      // Unix domain sockets inherit the process umask. Restrict the control plane even when it is permissive.
      if (!isNamedPipe(path)) await chmod(path, 0o600);
    } catch (error) {
      server.close();
      throw error;
    }

    this.server = server;
    this.path = path;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;

    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    } finally {
      const path = this.path!;
      this.path = undefined;
      await removeSocket(path);
    }
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void this.handleLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => this.sockets.delete(socket));
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      writeFrame(socket, { id: null, error: { message: 'Invalid IPC JSON' } });
      return;
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      writeFrame(socket, { id: null, error: { message: 'Invalid IPC request' } });
      return;
    }

    const request = message as Record<string, unknown>;
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
    if (typeof request.method !== 'string' || id === null) {
      writeFrame(socket, { id, error: { message: 'Invalid IPC request' } });
      return;
    }

    const handler = this.handlers.get(request.method);
    if (!handler) {
      writeFrame(socket, { id, error: { message: `Unknown IPC method: ${request.method}` } });
      return;
    }

    try {
      writeFrame(socket, { id, result: await handler(request.params) });
    } catch (error) {
      writeFrame(socket, { id, error: { message: errorMessage(error) } });
    }
  }
}

/** A newline-delimited JSON request client over a local Unix socket or Windows named pipe. */
export class LocalIpcClient {
  private buffer = '';
  private closed = true;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private socket: Socket | undefined;

  constructor(private path?: string) {}

  async connect(path = this.path): Promise<void> {
    if (!path) throw new Error('IPC socket path is required');
    if (this.socket && !this.socket.destroyed) throw new Error('IPC client is already connected');

    this.path = path;
    this.closed = false;
    const socket = createConnection(path);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (error) => this.finish(new Error(`IPC connection error: ${error.message}`)));
    socket.on('close', () => this.finish(new Error('IPC connection closed')));

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        socket.off('connect', onConnect);
        reject(new Error(`IPC connection error: ${error.message}`));
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const socket = this.socket;
    if (this.closed || !socket || socket.destroyed) {
      return Promise.reject(new Error('IPC connection is closed'));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      writeFrame(socket, params === undefined ? { id, method } : { id, method, params });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.finish(new Error('IPC connection closed'));
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;

    const response = message as Record<string, unknown>;
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(response, 'error')) {
      const error = response.error as { message?: unknown } | undefined;
      pending.reject(new Error(typeof error?.message === 'string' ? error.message : 'IPC request failed'));
      return;
    }
    pending.resolve(response.result);
  }

  private finish(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.socket = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
