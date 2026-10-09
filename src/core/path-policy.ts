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
//   decided by an NFA product construction (R4-02) — witness sampling
//   missed constructible overlaps like `src/a?c` vs `src/ab?`

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

// ---------------------------------------------------------------------------
// R4-02: provable glob intersection.
//
// Witness sampling is unsound for overlap DECISIONS: `src/a?c` and `src/ab?`
// both match `src/abc`, but any fixed pair of sample strings misses one side
// or the other. Ownership is a security boundary, so the check below decides
// intersection emptiness exactly with an NFA product construction.
//
// Soundness: transitions are either a concrete literal char or a wildcard.
// The alphabet is the literals occurring in BOTH patterns plus one fresh
// representative char for "any other char". Any common match can be
// rewritten position-wise into one over this alphabet: where either pattern
// pins a literal the char IS that literal; where both sides only use
// wildcards the char is replaceable by the representative (wildcards match
// it — it is a non-separator). So the product finds a witness iff one exists.
// ---------------------------------------------------------------------------

type GlobToken =
  | { t: 'lit'; ch: string }
  | { t: 'star' } // "*" — (any non-separator char)*, incl. empty
  | { t: 'qmark' } // "?" — exactly one non-separator char
  | { t: 'gstar' } // "**/" — (segment "/")*, each segment non-empty
  | { t: 'any' }; // bare "**" — any string, separators included

/** Tokenize exactly like globToRegex builds its regex: a double-star
 * followed by a slash repeats whole segments, every other double-star is an
 * unconstrained any-string. */
function tokenize(pattern: string): GlobToken[] {
  const pat = normalizePath(pattern);
  const tokens: GlobToken[] = [];
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i]!;
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        if (pat[i + 2] === '/') {
          tokens.push({ t: 'gstar' });
          i += 3;
        } else {
          tokens.push({ t: 'any' });
          i += 2;
        }
        continue;
      }
      tokens.push({ t: 'star' });
      i += 1;
      continue;
    }
    if (ch === '?') {
      tokens.push({ t: 'qmark' });
      i += 1;
      continue;
    }
    tokens.push({ t: 'lit', ch });
    i += 1;
  }
  return tokens;
}

type NfaTrans = { kind: 'eps' | 'char' | 'anyNonSep' | 'any'; ch?: string; to: number };

interface Nfa {
  start: number;
  accept: number;
  trans: NfaTrans[][];
}

/** Thompson construction over the token list (all fragments share one
 * transition table; states are table indices). */
function buildNfa(tokens: GlobToken[]): Nfa {
  const trans: NfaTrans[][] = [];
  const state = (): number => {
    trans.push([]);
    return trans.length - 1;
  };
  const eps = (from: number, to: number): void => {
    trans[from]!.push({ kind: 'eps', to });
  };

  const start = state();
  let cursor = start;
  for (const tok of tokens) {
    const next = state();
    switch (tok.t) {
      case 'lit':
        trans[cursor]!.push({ kind: 'char', ch: tok.ch, to: next });
        break;
      case 'qmark':
        trans[cursor]!.push({ kind: 'anyNonSep', to: next });
        break;
      case 'star':
        eps(cursor, next);
        trans[next]!.push({ kind: 'anyNonSep', to: next }); // (Σns)* loop
        break;
      case 'any':
        eps(cursor, next);
        trans[next]!.push({ kind: 'any', to: next }); // (Σ)* loop
        break;
      case 'gstar': {
        // ( seg "/" )* with seg = one-or-more non-separator chars
        const segStart = state();
        const segBody = state();
        eps(cursor, next); // zero segments
        eps(cursor, segStart);
        trans[segStart]!.push({ kind: 'anyNonSep', to: segBody }); // ≥1 char
        trans[segBody]!.push({ kind: 'anyNonSep', to: segBody });
        trans[segBody]!.push({ kind: 'char', ch: '/', to: segStart }); // segment done → repeat or…
        eps(segStart, next); // …exit after a complete "seg/"
        break;
      }
    }
    cursor = next;
  }
  const accept = state();
  eps(cursor, accept);
  return { start, accept, trans };
}

/** The NFAs a pattern is the union of. A pattern WITHOUT wildcard chars is
 * directory-like: it matches itself AND everything beneath it, i.e. the
 * union of `p` and `p/**`. */
function patternNfas(pattern: string): Nfa[] {
  const pat = normalizePath(pattern);
  if (!hasGlobChars(pat)) return [buildNfa(tokenize(pat)), buildNfa(tokenize(`${pat}/**`))];
  return [buildNfa(tokenize(pat))];
}

function epsClosure(nfa: Nfa, states: Set<number>): Set<number> {
  const stack = [...states];
  while (stack.length > 0) {
    const s = stack.pop()!;
    for (const t of nfa.trans[s]!) {
      if (t.kind === 'eps' && !states.has(t.to)) {
        states.add(t.to);
        stack.push(t.to);
      }
    }
  }
  return states;
}

function nfaStep(nfa: Nfa, states: Set<number>, c: string): Set<number> {
  const out = new Set<number>();
  for (const s of states) {
    for (const t of nfa.trans[s]!) {
      if (t.kind === 'eps') continue;
      if (t.kind === 'char' && t.ch === c) out.add(t.to);
      else if (t.kind === 'anyNonSep' && c !== '/') out.add(t.to);
      else if (t.kind === 'any') out.add(t.to);
    }
  }
  return out;
}

/** True iff some path is matched by both NFAs (exact, via product BFS). */
function nfasIntersect(a: Nfa, b: Nfa): boolean {
  // alphabet: literals from both patterns + '/' + one representative for
  // "any other char" (wildcards match it; it is a non-separator)
  const alphabet = new Set<string>(['/']);
  for (const nfa of [a, b]) {
    for (const outs of nfa.trans) {
      for (const t of outs) {
        if (t.kind === 'char' && t.ch) alphabet.add(t.ch);
      }
    }
  }
  let representative = '\u0000';
  while (alphabet.has(representative)) representative = String.fromCharCode(representative.charCodeAt(0) + 1);
  alphabet.add(representative);

  const startStates: [Set<number>, Set<number>] = [
    epsClosure(a, new Set([a.start])),
    epsClosure(b, new Set([b.start])),
  ];
  if (startStates[0].has(a.accept) && startStates[1].has(b.accept)) return true;
  const seen = new Set<string>();
  const frontier: Array<[Set<number>, Set<number>]> = [startStates];
  seen.add('s');
  while (frontier.length > 0) {
    const [ps, qs] = frontier.pop()!;
    for (const c of alphabet) {
      const np = nfaStep(a, ps, c);
      if (np.size === 0) continue;
      const nq = nfaStep(b, qs, c);
      if (nq.size === 0) continue;
      epsClosure(a, np);
      epsClosure(b, nq);
      if (np.has(a.accept) && nq.has(b.accept)) return true;
      const key = `${[...np].sort((x, y) => x - y).join(',')}|${[...nq].sort((x, y) => x - y).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frontier.push([np, nq]);
    }
  }
  return false;
}

/** True when some filesystem path could be claimed by both globs (exact
 * intersection decision — R4-02). */
export function globsIntersect(p1: string, p2: string): boolean {
  for (const na of patternNfas(p1)) {
    for (const nb of patternNfas(p2)) {
      if (nfasIntersect(na, nb)) return true;
    }
  }
  return false;
}

/** True when some filesystem path could be claimed by both pattern sets. */
export function ownershipConflict(a: readonly string[], b: readonly string[]): boolean {
  for (const pa of a) {
    for (const pb of b) {
      if (globsIntersect(pa, pb)) return true;
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
