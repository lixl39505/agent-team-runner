// Herdr version parsing/comparison and capability detection from
// `herdr api schema --json`.

/** Conservative floor; the real gate is the capability probe. */
export const MINIMUM_HERDR_VERSION = '0.7.0';

export function parseVersion(v: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va[i]! !== vb[i]!) return va[i]! - vb[i]!;
  }
  return 0;
}

export function isVersionAtLeast(actual: string, minimum: string): boolean {
  return compareVersions(actual, minimum) >= 0;
}

/** Recursively collect dotted method names found in the schema document. */
export function extractMethodNames(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof node === 'string') {
    if (/^[a-z][a-z_]*(\.[a-z_]+)+$/.test(node)) out.add(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) extractMethodNames(item, out);
    return out;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (/^[a-z][a-z_]*(\.[a-z_]+)+$/.test(key)) out.add(key);
      extractMethodNames(value, out);
    }
  }
  return out;
}

export interface HerdrCapabilities {
  worktree: boolean;
  agent: boolean;
  sessionSnapshot: boolean;
  reportAgent: boolean;
  plugin: boolean;
}

const REQUIRED_METHODS = {
  worktree: ['worktree.create', 'worktree.open', 'worktree.remove'],
  agent: ['agent.start', 'agent.prompt', 'agent.wait', 'agent.get'],
  sessionSnapshot: ['session.snapshot'],
  reportAgent: ['pane.report_agent'],
  plugin: ['plugin.link', 'plugin.action.list'],
} as const;

export function detectCapabilities(schemaJson: unknown): HerdrCapabilities {
  const methods = extractMethodNames(schemaJson);
  const has = (list: readonly string[]): boolean => list.every((m) => methods.has(m));
  return {
    worktree: has(REQUIRED_METHODS.worktree),
    agent: has(REQUIRED_METHODS.agent),
    sessionSnapshot: has(REQUIRED_METHODS.sessionSnapshot),
    reportAgent: has(REQUIRED_METHODS.reportAgent),
    plugin: has(REQUIRED_METHODS.plugin),
  };
}
