import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Fast unit tests only. Live/real-binary tests live in test/integration and are
// run via vitest.integration.config.ts (gated on KAIZEN_TEST_LIVE=1).
export default defineConfig({
  resolve: {
    alias: {
      '@kaizen/engine': path.resolve(import.meta.dirname, 'packages/engine/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
    environment: 'node',
    reporters: ['default'],
  },
});
