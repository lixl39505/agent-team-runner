import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { AgentInvocation, AgentRunResult } from '../core/types.js';

export async function spawnAgentProcess<T>(input: AgentInvocation, command: string, args: string[]): Promise<AgentRunResult<T>> {
  mkdirSync(dirname(input.logPath), { recursive: true });
  mkdirSync(dirname(input.outputPath), { recursive: true });
  writeFileSync(input.logPath, '', 'utf8');

  return await new Promise<AgentRunResult<T>>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    if (child.pid) input.onPid?.(child.pid);

    let stdout = '';
    let timedOut = false;
    let stalled = false;
    let lastActivity = Date.now();
    const append = (source: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = chunk.toString();
      if (source === 'stdout' && stdout.length < 10 * 1024 * 1024) stdout += text;
      appendFileSync(input.logPath, `[${source}] ${text}`, 'utf8');
      lastActivity = Date.now();
      input.onHeartbeat?.();
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', reject);

    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child.pid);
    }, input.timeoutMs);
    const stallTimer = setInterval(() => {
      if (Date.now() - lastActivity > input.staleAfterMs) {
        stalled = true;
        terminateTree(child.pid);
      }
    }, Math.min(5000, Math.max(1000, Math.floor(input.staleAfterMs / 4))));

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(stallTimer);
      resolve({ exitCode: code ?? 1, output: null, rawOutput: stdout, timedOut, stalled });
    });
  });
}

function terminateTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }, 5000).unref();
    }
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
}

export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* continue */ }
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].at(-1)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced.trim()); } catch { /* continue */ }
  }
  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as unknown;
      const candidate = findJsonCandidate(event);
      if (candidate !== undefined) return candidate;
    } catch { /* ignore non-JSON line */ }
  }
  const start = trimmed.lastIndexOf('{');
  if (start >= 0) {
    try { return JSON.parse(trimmed.slice(start)); } catch { /* ignore */ }
  }
  throw new Error('Agent did not return parseable JSON');
}

function findJsonCandidate(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['structured_output', 'output', 'result', 'text', 'content', 'message']) {
    if (key in record) {
      const candidate = findJsonCandidate(record[key]);
      if (candidate !== undefined) return candidate;
    }
  }
  return undefined;
}
