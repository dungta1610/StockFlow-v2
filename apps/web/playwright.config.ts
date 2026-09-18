import { defineConfig, devices } from '@playwright/test';

// Needs the full stack running (see e2e/ops-order-lifecycle.spec.ts's header comment
// for the exact commands): Postgres + Redis + the API on E2E_API_URL, and the web
// app itself on E2E_BASE_URL. Neither is started by this config — CI/local scripts
// bring the stack up first, run `pnpm --filter @stockflow/web test:e2e`, then tear it
// down, the same way `pnpm test` never starts Postgres for the API's integration tests.

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
