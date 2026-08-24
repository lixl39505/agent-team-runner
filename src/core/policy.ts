import { realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { PolicySpec, RunnerConfig, TaskSpec } from './types.js';
import { checkPaths } from './path-policy.js';
import { assertAllowedCommand } from './shell.js';

/** 只读 git 命令前缀：所有角色都可用于检查仓库状态（与事后验证器共享 token 语义） */
export const GIT_READ_COMMAND_PREFIXES = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git rev-parse',
  'git ls-files'
];

/** 只读探索命令：worker 迭代必需的基础文件查看能力（E2E 实测缺它们会 deny-thrash 烧尽上下文） */
export const READ_ONLY_COMMAND_PREFIXES = [
  'ls',
  'cat',
  'head',
  'tail',
  'find',
  'grep',
  'rg',
  'wc',
  'pwd',
  'stat',
  'which',
  'diff',
  'sort',
  'uniq',
  'echo'
];

export interface PolicyDecision {
  allowed: boolean;
  /** 拒绝原因会原样返回给模型，避免其反复重试（thrash） */
  reason?: string;
}

/** Lead / Reviewer：只读仓库，可跑只读 git 与探索命令，无网络 */
export function readOnlyPolicy(): PolicySpec {
  return {
    fs: { mode: 'read-only' },
    bash: { mode: 'prefixes', prefixes: [...GIT_READ_COMMAND_PREFIXES, ...READ_ONLY_COMMAND_PREFIXES] },
    network: false
  };
}

/** Worker：可写范围 = 任务路径策略，命令 = 只读 git/探索 + mkdir + 配置的验证命令前缀 */
export function workerPolicy(task: TaskSpec, config: RunnerConfig): PolicySpec {
  return {
    fs: { mode: 'workspace-write', allowedPaths: task.allowedPaths, blockedPaths: task.blockedPaths },
    bash: { mode: 'prefixes', prefixes: [...GIT_READ_COMMAND_PREFIXES, ...READ_ONLY_COMMAND_PREFIXES, 'mkdir', ...config.verification.allowedCommandPrefixes] },
    network: false
  };
}

/** Integrator：resolve_conflict 只能改冲突文件；finalize 只能改 integration.allowedPaths */
export function integratorPolicy(
  mode: 'resolve_conflict' | 'finalize',
  config: RunnerConfig,
  conflictFiles: string[] = []
): PolicySpec {
  const allowedPaths = mode === 'resolve_conflict' ? conflictFiles : config.integration.allowedPaths;
  return {
    fs: { mode: 'workspace-write', allowedPaths, blockedPaths: [] },
    bash: { mode: 'prefixes', prefixes: [...GIT_READ_COMMAND_PREFIXES, ...READ_ONLY_COMMAND_PREFIXES, 'mkdir', ...config.verification.allowedCommandPrefixes] },
    network: false
  };
}

/** 命令裁决：与事后验证器 (shell.assertAllowedCommand) 完全相同的 token 前缀语义；拒绝时附上允许清单帮助模型自纠 */
export function decideBash(policy: PolicySpec, command: string): PolicyDecision {
  if (policy.bash.mode === 'deny') {
    return { allowed: false, reason: 'command execution is denied for this role' };
  }
  try {
    assertAllowedCommand(command, policy.bash.prefixes);
    return { allowed: true };
  } catch (error) {
    const base = error instanceof Error ? error.message : String(error);
    const sample = policy.bash.prefixes.slice(0, 16).join('; ');
    return { allowed: false, reason: `${base}. Allowed command prefixes for this role: ${sample}${policy.bash.prefixes.length > 16 ? '; …' : ''}` };
  }
}

/** 路径裁决：与事后验证器 (path-policy.checkPaths) 完全相同的 glob 语义 */
export function decideWrite(policy: PolicySpec, path: string, cwd?: string): PolicyDecision {
  const target = toRelativePath(path, cwd);
  if (policy.fs.mode === 'read-only') {
    return { allowed: false, reason: `this role is read-only; refusing to modify "${target}"` };
  }
  const verdict = checkPaths([target], policy.fs.allowedPaths, policy.fs.blockedPaths);
  if (verdict.ok) return { allowed: true };
  if (verdict.blocked.length > 0) {
    return { allowed: false, reason: `"${target}" matches a blocked path pattern for this role` };
  }
  return { allowed: false, reason: `"${target}" is outside the allowed paths for this role` };
}

/**
 * 工具调用裁决（claude canUseTool / 后端审批应答的共用入口）。
 * 工具名大小写不敏感；未知工具默认放行（事后验证器兜底）。
 */
export function decideTool(policy: PolicySpec, tool: string, input: unknown, cwd?: string): PolicyDecision {
  const record = (input ?? {}) as Record<string, unknown>;
  switch (tool.toLowerCase()) {
    case 'bash':
      return decideBash(policy, String(record.command ?? ''));
    case 'edit':
    case 'write':
    case 'notebookedit':
      return decideWrite(policy, String(record.file_path ?? record.notebook_path ?? record.path ?? ''), cwd);
    case 'webfetch':
    case 'websearch':
      return policy.network
        ? { allowed: true }
        : { allowed: false, reason: 'network access is disabled for this role' };
    default:
      return { allowed: true };
  }
}

/** 会话内绝对/相对路径 → 相对 cwd 的路径；越界路径保持绝对形态，交给 glob 校验拒绝 */
function toRelativePath(path: string, cwd?: string): string {
  if (!cwd || path === '') return path;
  // macOS 下 cwd 常见为 /var/folders/... 而 agent 工具返回 realpath /private/var/...，
  // 两侧都做 realpath 归一再比较。目标文件可能尚不存在（Write 新文件的常态）——
  // 此时 realpath 父目录再拼回文件名，避免 ENOENT 回退到未解析的符号链接形态被误拒。
  const realCwd = tryRealpath(cwd) ?? cwd;
  const resolved = resolve(realCwd, path);
  const realResolved = tryRealpath(resolved) ?? tryRealpathParent(resolved) ?? resolved;
  if (realResolved === realCwd || realResolved.startsWith(realCwd + sep)) return relative(realCwd, realResolved);
  return realResolved;
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function tryRealpathParent(path: string): string | undefined {
  const parent = dirname(path);
  const realParent = tryRealpath(parent);
  return realParent === undefined ? undefined : join(realParent, basename(path));
}
