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

export function checkPaths(files: string[], allowed: string[], blocked: string[]): PathCheckResult {
  const invalid: string[] = [];
  const denied: string[] = [];
  for (const file of files) {
    if (blocked.some((pattern) => globMatch(file, pattern))) {
      denied.push(file);
      continue;
    }
    if (!allowed.some((pattern) => globMatch(file, pattern))) invalid.push(file);
  }
  return { ok: invalid.length === 0 && denied.length === 0, invalid, blocked: denied };
}
