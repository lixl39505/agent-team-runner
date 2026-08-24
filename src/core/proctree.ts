import { spawn } from 'node:child_process';

/**
 * 终止进程树。Agent/后端子进程以进程组长启动（detached），
 * 杀整个组才能带走 CLI 的孙子进程。
 * hold=true 时保持定时器存活，保证 SIGKILL 升级必然发生（stop 命令用）。
 */
export function terminateTree(pid: number | undefined, hold = false): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
      const escalate = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
      }, 5000);
      if (!hold) escalate.unref();
    }
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
}
