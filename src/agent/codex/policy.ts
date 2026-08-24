import type { PolicySpec } from '../../core/types.js';
import { decideBash, decideWrite } from '../../core/policy.js';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy.js';

/**
 * codex app-server 的 sandboxPolicy——直接复用 vendored 协议类型，
 * 上游协议漂移会让本文件编译失败（升级流程：gen:codex → npm run check）。
 */
export type CodexSandboxPolicy = SandboxPolicy;

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline';

export interface CompiledCodexPolicy {
  sandboxPolicy: CodexSandboxPolicy;
  /** untrusted：命令审批尽量路由给客户端（等价 claude 的 default 模式） */
  approvalPolicy: 'untrusted';
  /** 命令审批：与事后验证器同语义的 token 前缀匹配；allowlisted 命令给 acceptForSession 减少往返 */
  decideCommand(command: string): CodexApprovalDecision;
  /**
   * 文件变更审批：codex 的 sandbox 只认根目录不认 glob，
   * 只读角色拒绝一切；workspace-write 角色放行（sandbox 已限定在 cwd，
   * 任务级 allowedPaths 的精细约束由事后验证器兜底——诚实记录这一不对称）。
   */
  decideFileChange(): CodexApprovalDecision;
  /** 路径裁决（供需要 path 的调用点复用） */
  decideWrite(path: string, cwd: string): boolean;
}

export function compileCodex(policy: PolicySpec, cwd: string): CompiledCodexPolicy {
  const sandboxPolicy: CodexSandboxPolicy = policy.fs.mode === 'read-only'
    ? { type: 'readOnly', networkAccess: policy.network }
    : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: policy.network, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  return {
    sandboxPolicy,
    approvalPolicy: 'untrusted',
    decideCommand(command) {
      const decision = decideBash(policy, command);
      if (decision.allowed) return 'acceptForSession';
      return 'decline';
    },
    decideFileChange() {
      return policy.fs.mode === 'read-only' ? 'decline' : 'accept';
    },
    decideWrite(path, workdir) {
      return decideWrite(policy, path, workdir).allowed;
    }
  };
}
