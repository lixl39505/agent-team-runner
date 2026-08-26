/**
 * OpenCode has no process sandbox, so read-only roles hard-deny mutating tools.
 * Workspace roles auto-answer direct edits but leave commands, network, and external paths to native asks.
 */
export interface CompiledOpenCodePolicy {
  serverPermission: Record<string, unknown>;
  access: 'read-only' | 'workspace-write';
}

export function compileOpenCodeBasePermission(): Record<string, unknown> {
  return {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    skill: 'allow',
    todoread: 'allow',
    todowrite: 'allow',
    question: 'allow',
    bash: 'ask',
    edit: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    external_directory: 'ask'
  };
}

export function compileOpenCode(access: 'read-only' | 'workspace-write'): CompiledOpenCodePolicy {
  return { serverPermission: compileOpenCodeBasePermission(), access };
}
