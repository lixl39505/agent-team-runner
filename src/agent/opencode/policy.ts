import type { PolicySpec } from '../../core/types.js';
import { decideBash, decideWrite } from '../../core/policy.js';

/**
 * opencode 权限编译：服务端全局把危险操作设为 'ask'（edit/bash/webfetch），
 * 运行时由 Runner 按 session 策略应答 once/reject——闭环授权。
 */
export interface CompiledOpenCodePolicy {
  serverPermission: Record<string, unknown>;
  /** permission.updated 事件 → once | reject */
  decide(request: { type: string; pattern?: string | Array<string> | undefined }, cwd: string): 'once' | 'reject';
}

export function compileOpenCodeBasePermission(): Record<string, unknown> {
  // 服务端级"最大门禁"：所有危险操作都 ask，具体放行由每个 session 的策略运行时决定
  return {
    bash: 'ask',
    edit: 'ask',
    webfetch: 'ask'
  };
}

export function compileOpenCode(policy: PolicySpec): CompiledOpenCodePolicy {
  return {
    serverPermission: compileOpenCodeBasePermission(),
    decide(request, cwd) {
      switch (request.type) {
        case 'bash': {
          const command = Array.isArray(request.pattern) ? request.pattern.join(' ') : String(request.pattern ?? '');
          const decision = decideBash(policy, command);
          return decision.allowed ? 'once' : 'reject';
        }
        case 'edit': {
          const paths = Array.isArray(request.pattern) ? request.pattern : [String(request.pattern ?? '')];
          const allowed = paths.every((path) => decideWrite(policy, path, cwd).allowed);
          return allowed ? 'once' : 'reject';
        }
        case 'webfetch':
          return policy.network ? 'once' : 'reject';
        default:
          return 'reject';
      }
    }
  };
}
