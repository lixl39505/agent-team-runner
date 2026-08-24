import type { PolicySpec } from '../../core/types.js';
import { decideTool } from '../../core/policy.js';

/**
 * 只读工具直接放进 allowedTools（不经过 canUseTool——它们无副作用）。
 * 关键约束：Bash/Edit/Write/NotebookEdit 绝不能出现在 allowedTools，
 * 否则会绕过 canUseTool（shadow），权限闭环失效。
 */
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

/** 无头团队运行中没有可交互的用户，显式拒绝交互类工具 */
const HEADLESS_DENIED_TOOLS = ['AskUserQuestion'];

export type ClaudePolicyDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface CompiledClaudePolicy {
  /** 必须是 'default'：dontAsk 会静默拒绝且不触发回调；acceptEdits 会自动放行编辑 */
  permissionMode: 'default';
  allowedTools: string[];
  disallowedTools: string[];
  decide(toolName: string, input: Record<string, unknown>, cwd: string): ClaudePolicyDecision;
}

/** 把 PolicySpec 编译成 Claude Agent SDK 的权限配置（纯函数，单测核心） */
export function compileClaude(policy: PolicySpec): CompiledClaudePolicy {
  const disallowedTools = [...HEADLESS_DENIED_TOOLS];
  if (!policy.network) disallowedTools.push('WebFetch', 'WebSearch', 'WebSearch');
  return {
    permissionMode: 'default',
    allowedTools: [...CLAUDE_READ_ONLY_TOOLS],
    disallowedTools: [...new Set(disallowedTools)],
    decide(toolName, input, cwd) {
      const decision = decideTool(policy, toolName, input, cwd);
      if (decision.allowed) return { behavior: 'allow' };
      return { behavior: 'deny', message: decision.reason ?? 'denied by runner policy' };
    }
  };
}
