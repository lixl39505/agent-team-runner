import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    exclude: ['test/integration-*.test.mjs'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'lcov'],
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/agent/codex/protocol/**'],
      thresholds: {
        branches: 100,
        functions: 100
      }
    }
  }
});
