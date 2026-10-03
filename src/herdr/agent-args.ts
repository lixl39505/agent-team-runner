// Native launch-argument mapping per agent kind. `herdr agent start --kind
// <k> -- <args>` forwards argv unchanged to the kind's canonical binary;
// these tables encode each binary's model/resume conventions.

import type { AgentKind } from '../core/types.ts';
import type { AgentEntry } from '../config.ts';

/** Launch argv appended after `--` in `herdr agent start`. */
export function agentStartArgs(entry: AgentEntry): string[] {
  const args: string[] = [];
  if (entry.model) args.push('--model', entry.model);
  args.push(...(entry.args ?? []));
  return args;
}

/**
 * Resume argv for a native session reference, per Herdr's integration
 * resume conventions: claude `--resume <id>`, codex `resume <id>`,
 * opencode `--session <id>`.
 */
export function agentResumeArgs(kind: AgentKind, sessionRef: string): string[] {
  switch (kind) {
    case 'claude':
      return ['--resume', sessionRef];
    case 'codex':
      return ['resume', sessionRef];
    case 'opencode':
      return ['--session', sessionRef];
  }
}
