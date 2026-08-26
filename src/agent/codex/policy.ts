import type { SandboxPolicy } from './protocol/v2/SandboxPolicy.js';

/**
 * codex app-server 的 sandboxPolicy——直接复用 vendored 协议类型，
 * 上游协议漂移会让本文件编译失败（升级流程：gen:codex → npm run check）。
 */
export type CodexSandboxPolicy = SandboxPolicy;

export interface CompiledCodexPolicy {
  sandboxPolicy: CodexSandboxPolicy;
  /** untrusted：命令审批尽量路由给客户端（等价 claude 的 default 模式） */
  approvalPolicy: 'untrusted';
  access: 'read-only' | 'workspace-write';
}

export function compileCodex(access: 'read-only' | 'workspace-write', cwd: string): CompiledCodexPolicy {
  const sandboxPolicy: CodexSandboxPolicy = access === 'read-only'
    ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  return {
    sandboxPolicy,
    approvalPolicy: 'untrusted',
    access
  };
}
