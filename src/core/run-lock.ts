import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTeamHome } from './home.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 同一 runId 的进程互斥锁：runs/<id>/lock/pid 记录持有者，崩溃残留可被接管。 */
export function acquireRunLock(home: AgentTeamHome, runId: string): void {
  const lockDir = join(home.runsDir, runId, 'lock');
  const pidFile = join(lockDir, 'pid');
  mkdirSync(lockDir, { recursive: true });
  // 抢占上限：锁文件只在「判定残留 → 原子拿走」之间有限轮转，不可能无限竞争。
  for (let attempt = 0; attempt < 32; attempt += 1) {
    // 独占创建（wx）是唯一的所有权判定点：两个进程同时创建只会有一个成功。
    try {
      writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readLockPid(pidFile);
    if (holder !== undefined && isProcessAlive(holder)) {
      throw new Error(`Run ${runId} is already executing in another process (pid ${holder})`);
    }
    // 原子接管：rename 拿走残留锁文件，输家得到 ENOENT 回到重试。
    // 竞争者因此不可能删掉我们刚创建的锁（TOCTOU：读到的 pid 已死 ≠ 现在的文件还是它）。
    const stolen = `${pidFile}.steal-${process.pid}`;
    try {
      renameSync(pidFile, stolen);
    } catch {
      // 锁已被其他接管者拿走：按最新状态重新判定。单线程测试无法产生该竞争窗口。
      /* istanbul ignore next -- 仅并发接管者竞争 rename 时可达。 */
      continue;
    }
    try {
      const stolenPid = readLockPid(stolen);
      /* istanbul ignore if -- 单线程下 rename 前后内容不可能变化；该分支防并发接管者刷新锁。 */
      if (stolenPid !== holder) {
        // 判死之后锁已被并发接管者刷新：把锁还回去，按新持有者重新判定。
        try {
          renameSync(stolen, pidFile);
        } catch {
          // 还回失败（新持有者已重建锁文件）：按最新状态重新判定。
        }
        continue;
      }
    } finally {
      rmSync(stolen, { force: true });
    }
  }
  /* istanbul ignore next -- 每轮接管都会取得进展；只有无限并发竞争才能耗尽轮次。 */
  throw new Error(`Run ${runId} lock is contended by concurrent takeover attempts`);
}

function readLockPid(pidFile: string): number | undefined {
  try {
    const parsed = Number(readFileSync(pidFile, 'utf8'));
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  } catch {
    // 仅在 EEXIST 与读取之间锁文件被并发接管者拿走时可达（按残留处理）。
    /* istanbul ignore next */
    return undefined;
  }
}

export function releaseRunLock(home: AgentTeamHome, runId: string): void {
  rmSync(join(home.runsDir, runId, 'lock'), { recursive: true, force: true });
}
