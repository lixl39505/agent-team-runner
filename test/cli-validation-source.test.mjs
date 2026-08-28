import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

vi.mock('../src/core/config.ts', () => ({
  loadConfig: (repoRoot) => ({
    repoRoot,
    stateDir: `${repoRoot}/state`,
    defaultAgent: 'default',
    agents: { default: { backend: 'claude' } },
    roles: {}
  }),
  applyOverrides: (config) => config,
  initConfig: () => ''
}));
vi.mock('../src/core/agent-config.ts', () => ({
  backendCommand: () => '',
  validateAgents: () => ({ ok: false, errors: ['invalid agent'], warnings: [] })
}));

const { runCli } = await import('../src/cli.ts');

test('runCli fails plan before constructing backends for invalid agent configuration', async () => {
  await assert.rejects(runCli(['plan', 'goal.md', '--repo', '/tmp/cli-invalid']), /Invalid agent config/);
});
