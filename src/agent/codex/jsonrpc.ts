import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { killProcessTree } from '../process-tree.js';

/** stdio 换行分隔 JSON 的帧解析（纯函数，单测核心） */
export function parseFrames(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  let rest = buffer;
  let index = rest.indexOf('\n');
  while (index >= 0) {
    const line = rest.slice(0, index).trim();
    if (line.length > 0) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* 跳过无法解析的行（协议噪声） */
      }
    }
    rest = rest.slice(index + 1);
    index = rest.indexOf('\n');
  }
  return { messages, rest };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface JsonRpcHandlers {
  onNotification?: (method: string, params: unknown) => void;
  /** 服务端主动请求（如审批）：返回 result 或抛错 */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  onExit?: (error: Error) => void;
}

/**
 * codex app-server 的 stdio JSON-RPC 客户端。
 * 请求形如 {method, id, params}；响应 {id, result|error}；双向均有通知（无 id）。
 */
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = '';
  private closed = false;
  private exitReported = false;
  private readonly child: ChildProcess;

  constructor(
    command: string,
    args: string[],
    private readonly handlers: JsonRpcHandlers = {},
    env: Record<string, string> = process.env as Record<string, string>,
    cwd?: string
  ) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      ...(cwd ? { cwd } : {}),
      detached: process.platform !== 'win32'
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      if (!this.closed && chunk.trim()) process.stderr.write(`[codex-app-server] ${chunk}`);
    });
    this.child.on('close', () => {
      this.closed = true;
      this.failAll(new Error('app-server process exited'));
    });
    this.child.on('error', (error) => {
      this.closed = true;
      this.failAll(new Error(`app-server process error: ${error.message}`));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get exited(): boolean {
    return this.closed;
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('app-server connection is closed'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ method, id, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('connection closed'));
    }
    this.pending.clear();
    try {
      killProcessTree(this.child, 'SIGTERM');
      // SIGKILL 升级保持 ref'd：子进程不死 → stdio 管道句柄不释放 → 事件循环不排干。
      // ref 的定时器保证 3 秒内强杀子进程，管道随之关闭，宿主进程可正常退出。
      setTimeout(() => {
        try {
          killProcessTree(this.child, 'SIGKILL');
        } catch { /* already exited */ }
      }, 3_000);
    } catch { /* already exited */ }
  }

  private send(message: unknown): void {
    if (this.closed) return;
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.exitReported) {
      this.exitReported = true;
      this.handlers.onExit?.(error);
    }
  }

  private receive(chunk: string): void {
    const { messages, rest } = parseFrames(this.buffer + chunk);
    this.buffer = rest;
    for (const message of messages) void this.dispatch(message);
  }

  private async dispatch(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    if (typeof record.method === 'string') {
      if (record.id !== undefined && record.id !== null) {
        // 服务端主动请求
        try {
          const result = await this.handlers.onServerRequest?.(record.method, record.params) ?? null;
          this.send({ id: record.id, result });
        } catch (error) {
          this.send({ id: record.id, error: { message: error instanceof Error ? error.message : String(error) } });
        }
        return;
      }
      this.handlers.onNotification?.(record.method, record.params);
      return;
    }
    if (record.id !== undefined && record.id !== null) {
      const pending = this.pending.get(Number(record.id));
      if (!pending) return;
      this.pending.delete(Number(record.id));
      clearTimeout(pending.timer);
      if (record.error !== undefined) {
        const error = record.error as { message?: string };
        pending.reject(new Error(String(error.message ?? 'app-server request failed')));
      } else {
        pending.resolve(record.result);
      }
    }
  }
}
