/**
 * 只读工具直接放进 allowedTools（不经过 canUseTool——它们无副作用）。
 * 关键约束：Bash/Edit/Write/NotebookEdit 绝不能出现在 allowedTools，
 * 否则会绕过 canUseTool（shadow），权限闭环失效。
 */
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

export interface CompiledClaudePolicy {
  /** 必须是 'default'：dontAsk 会静默拒绝且不触发回调；acceptEdits 会自动放行编辑 */
  permissionMode: 'default';
  allowedTools: string[];
  disallowedTools: string[];
}

/** Compile only the role boundary; Claude remains responsible for operation-level permission requests. */
export function compileClaude(access: 'read-only' | 'workspace-write'): CompiledClaudePolicy {
  const disallowedTools = access === 'read-only'
    ? ['Edit', 'Write', 'NotebookEdit', 'Task', 'AskUserQuestion']
    : ['AskUserQuestion'];
  return {
    permissionMode: 'default',
    allowedTools: [...CLAUDE_READ_ONLY_TOOLS],
    disallowedTools
  };
}
