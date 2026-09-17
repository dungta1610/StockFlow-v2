import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Test isolation strategy (docs/adr/0006): one Postgres + one Redis container for
// the whole run, tables truncated and Redis flushed before every test, and test
// files run one at a time. Parallel files would truncate each other's fixtures —
// exactly the flakiness the concurrency tests cannot afford.
export default defineConfig({
  plugins: [
    // Vitest's default transform does not emit decorator metadata, which Nest DI needs.
    swc.vite({ module: { type: 'es6' } }),
  ],
  resolve: {
    // Tests consume the contracts package from source; the built dist is for runtime.
    alias: { '@stockflow/contracts': resolve(__dirname, '../../packages/contracts/src/index.ts') },
  },
  test: {
    globals: true,
    root: __dirname,
    include: ['test/**/*.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
