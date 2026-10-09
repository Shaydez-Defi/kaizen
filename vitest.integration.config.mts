import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Live integration tests: spawn REAL portaldot_dev processes and connect over
// real RPC. Gated on KAIZEN_TEST_LIVE=1 (otherwise the suite skips with a
// notice — a skipped test is never reported as passing).
export default defineConfig({
  resolve: {
    alias: {
      '@kaizen/engine': path.resolve(import.meta.dirname, 'packages/engine/src/index.ts'),
    },
  },
  test: {
    include: ['test/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // Real nodes are heavy; run integration files sequentially.
    fileParallelism: false,
    reporters: ['default'],
  },
});
