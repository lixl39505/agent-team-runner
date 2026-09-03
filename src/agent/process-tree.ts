import { spawn, type ChildProcess } from 'node:child_process';

/** Terminate the managed process and its descendants on every supported host platform. */
export function killProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', () => {
        try { child.kill(signal); } catch { /* already exited */ }
      });
      killer.unref();
    } catch {
      try { child.kill(signal); } catch { /* already exited */ }
    }
    return;
  }
  // 子进程不再以 detached 启动（避免 CLI 被杀后 serve/app-server 残留为孤儿会话首，
  // 违反「run 生命周期等于 CLI 进程生命周期」），多数情况下没有独立进程组可杀。
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}
