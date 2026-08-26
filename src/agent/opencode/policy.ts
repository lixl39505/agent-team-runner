/**
 * OpenCode has no process sandbox, so read-only roles hard-deny mutating tools.
 * Workspace roles leave operation-level decisions to native permission requests.
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
