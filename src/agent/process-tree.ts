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
  process.kill(-pid, signal);
}
