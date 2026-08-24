import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProbeCacheEntry {
  ok: boolean;
  error?: string | undefined;
  latencyMs: number;
  checkedAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * probe 结果持久缓存：key = backend|model|backendVersion。
 * 版本号进 key —— CLI 升级后自动失效重测；TTL 兜底。
 */
export class ProbeCache {
  private entries: Record<string, ProbeCacheEntry> = {};

  constructor(
    private readonly filePath: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS
  ) {
    try {
      if (existsSync(filePath)) {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { entries?: Record<string, ProbeCacheEntry> };
        this.entries = parsed.entries ?? {};
      }
    } catch {
      this.entries = {};
    }
  }

  private key(backend: string, model: string, version: string | undefined): string {
    return [backend, model, version ?? 'unknown'].join('|');
  }

  get(backend: string, model: string, version: string | undefined): ProbeCacheEntry | null {
    const entry = this.entries[this.key(backend, model, version)];
    if (!entry) return null;
    if (Date.now() - entry.checkedAt > this.ttlMs) return null;
    return entry;
  }

  set(backend: string, model: string, version: string | undefined, entry: ProbeCacheEntry): void {
    this.entries[this.key(backend, model, version)] = entry;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify({ entries: this.entries }, null, 2)}\n`, 'utf8');
    } catch {
      /* 缓存写失败不阻塞预检 */
    }
  }
}
