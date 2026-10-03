// Glob path matching and exclusive path ownership between tasks.
//
// Semantics:
// - separators are always "/" (normalized from Windows "\")
// - "**" spans zero or more whole segments ("**/x" also matches "x",
//   trailing "/**" requires at least one segment below the prefix)
// - "*" stays inside one segment, "?" matches one non-separator char
// - a pattern with NO wildcard chars is directory-like: it matches itself
//   and everything beneath it
// - ownership conflict = there can exist a path matched by both patterns;
//   decided via concrete witness paths generated from each glob

export function normalizePath(p: string): string {
  const unified = p.replaceAll('\\', '/');
  // collapse duplicate slashes except a leading "//" (UNC) — keep it simple:
  const collapsed = unified.replaceAll(/(?<=[^:])\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

function hasGlobChars(p: string): boolean {
  return /[*?]/.test(p) || p.includes('**');
}

export function globToRegex(pattern: string): RegExp {
  const pat = normalizePath(pattern);
  let re = '';
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i]!;
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        // "**"
        if (pat[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

export function matchPath(pattern: string, path: string): boolean {
  const p = normalizePath(path);
  const pat = normalizePath(pattern);
  if (!hasGlobChars(pat)) {
    return p === pat || p.startsWith(`${pat}/`);
  }
  return globToRegex(pat).test(p);
}

export function matchAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((pat) => matchPath(pat, path));
}

/** Concrete paths a glob can match, used for pairwise overlap decisions. */
function witnesses(pattern: string): string[] {
  const pat = normalizePath(pattern);
  if (!hasGlobChars(pat)) return [pat, `${pat}/file.txt`];
  const shallow = pat.replaceAll('**/', '').replaceAll('/**', '/a').replaceAll('**', 'a').replaceAll('*', 'a').replaceAll('?', 'x');
  const deep = pat
    .replaceAll('**/', 'a/b/')
    .replaceAll('/**', '/a/b')
    .replaceAll('**', 'a/b')
    .replaceAll('*', 'abc')
    .replaceAll('?', 'x');
  return [shallow, deep];
}

function canMatch(pattern: string, candidate: string): boolean {
  return matchPath(pattern, candidate);
}

/** True when some filesystem path could be claimed by both pattern sets. */
export function ownershipConflict(a: readonly string[], b: readonly string[]): boolean {
  for (const pa of a) {
    for (const pb of b) {
      const witnessesB = witnesses(pb);
      const witnessesA = witnesses(pa);
      if (witnessesB.some((w) => canMatch(pa, w))) return true;
      if (witnessesA.some((w) => canMatch(pb, w))) return true;
    }
  }
  return false;
}

/** Whether edits under path are allowed for a task given its policy sets. */
export function isPathAllowed(task: { allowedPaths: readonly string[]; blockedPaths?: readonly string[] }, path: string): boolean {
  if (!matchAny(task.allowedPaths, path)) return false;
  if (task.blockedPaths && task.blockedPaths.length > 0 && matchAny(task.blockedPaths, path)) return false;
  return true;
}

/** Paths ATeam itself owns inside a worktree; agents must never touch. */
export const ATEAM_INTERNAL_PATTERNS: readonly string[] = ['.ateam/**'];
