import type { RunnerConfig } from './types.js';

/**
 * Pure runtime defaults used when a persisted project policy omits an optional
 * value. Workspace paths are placeholders and must be replaced by a caller.
 */
export const DEFAULT_CONFIG: RunnerConfig = {
  version: 3,
  defaultAgent: 'default-claude',
  concurrency: 3,
  staleAfterMs: 10 * 60 * 1000,
  taskTimeoutMs: 2 * 60 * 60 * 1000,
  workspace: {
    repoRoot: '.',
    stateDir: '',
    worktreesDir: '',
    baseRef: 'HEAD',
    branchPrefix: 'agent-team'
  },
  retry: {
    maxWorkerAttempts: 2,
    maxReviewCycles: 2
  },
  status: {
    pollIntervalMs: 2000
  },
  interactionAlert: {
    background: '#7C3AED',
    foreground: '#FFFFFF'
  },
  backends: {
    claude: { nativeWindowsSandbox: 'require' },
    codex: { nativeWindowsSandbox: 'require' },
    opencode: { nativeWindowsSandbox: 'require' }
  },
  agents: {
    'default-claude': { backend: 'claude' }
  },
  roles: {},
  verification: {
    allowedCommandPrefixes: [
      'pnpm test',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm build',
      'npm test',
      'npm run',
      'yarn test',
      'yarn lint',
      'yarn build',
      'bun test',
      'go test',
      'cargo test',
      'make test'
    ],
    globalCommands: []
  },
  integration: {
    allowedPaths: ['specs/**']
  }
};
