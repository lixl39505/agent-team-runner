import { defineConfig } from 'vitest/config';

/**
 * 集成测试专用配置：真实后端（协议层/全会话）需要更长超时与串行执行，
 * 且必须从默认 vitest 配置的 exclude 中排除出来单独运行。
 */
export default defineConfig({
  test: {
    include: ['test/integration-*.test.mjs'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000
  }
});
