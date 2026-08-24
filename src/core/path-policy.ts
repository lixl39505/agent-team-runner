export interface PathCheckResult {
  ok: boolean;
  invalid: string[];
  blocked: string[];
}

export function globMatch(path: string, glob: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedGlob = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let regex = '^';
  for (let index = 0; index < normalizedGlob.length; index += 1) {
    const char = normalizedGlob[index]!;
    const next = normalizedGlob[index + 1];
    if (char === '*' && next === '*') {
      const after = normalizedGlob[index + 2];
      if (after === '/') {
        regex += '(?:.*/)?';
        index += 2;
      } else {
        regex += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') { regex += '[^/]*'; continue; }
    if (char === '?') { regex += '[^/]'; continue; }
    regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  regex += '$';
  return new RegExp(regex).test(normalizedPath);
}

/**
 * 模式匹配：glob 语义之外，无通配符且末段不含 "." 的裸目录名（Lead 常见输出，如 `src`）
 * 视为目录前缀，匹配其整个子树。allowed 与 blocked 对称适用。
 */
export function patternMatches(file: string, pattern: string): boolean {
  if (globMatch(file, pattern)) return true;
  if (!/[*?]/.test(pattern)) {
    const lastSegment = pattern.replace(/\\/g, '/').split('/').pop() ?? '';
    if (!lastSegment.includes('.')) {
      return file === pattern || file.startsWith(`${pattern}/`) || globMatch(file, `${pattern}/**`);
    }
  }
  return false;
}

export function checkPaths(files: string[], allowed: string[], blocked: string[]): PathCheckResult {
  const invalid: string[] = [];
  const denied: string[] = [];
  for (const file of files) {
    if (blocked.some((pattern) => patternMatches(file, pattern))) {
      denied.push(file);
      continue;
    }
    if (!allowed.some((pattern) => patternMatches(file, pattern))) invalid.push(file);
  }
  return { ok: invalid.length === 0 && denied.length === 0, invalid, blocked: denied };
}
