import { expect, test } from '@playwright/test';

/**
 * Two tabs whose access token expires together refresh exactly once across the
 * origin, and both keep working (phase-09-web-ops-console.md's refresh-mutex
 * acceptance criterion — two tabs, one refresh call, no one logged out).
 *
 * This needs the access token to actually expire server-side, not just be dropped
 * from a tab's in-memory store (a page reload would do that on its own and would not
 * prove anything about the real bug: concurrent 401s racing the rotating refresh
 * token — see docs/adr and phase-09's "Refresh mutex" section). So the API under
 * test must be started with a short `JWT_ACCESS_TTL_SECONDS`, and this spec is told
 * that value via `E2E_ACCESS_TTL_SECONDS` so it knows how long to wait. It is opt-in
 * (skipped otherwise) so the default `pnpm test:e2e` run — against an API using the
 * normal 900s TTL — does not hang waiting for a token that won't expire in time.
 *
 *   JWT_ACCESS_TTL_SECONDS=3 pnpm --filter @stockflow/api start:dev
 *   # (same postgres/redis/migrate steps as ops-order-lifecycle.spec.ts)
 *
 *   cd apps/web
 *   E2E_ACCESS_TTL_SECONDS=3 E2E_BASE_URL=http://localhost:5173 E2E_API_URL=http://localhost:3100 \
 *     pnpm exec playwright test two-tab-refresh
 *
 * A short TTL doesn't affect ops-order-lifecycle.spec.ts's correctness (that spec
 * finishes in well under a second of app time), so both specs can run against the
 * same short-TTL API in one session if convenient.
 */

const ACCESS_TTL_SECONDS = process.env.E2E_ACCESS_TTL_SECONDS ? Number(process.env.E2E_ACCESS_TTL_SECONDS) : undefined;
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD ?? 'ChangeMe-123!';
const OPS_EMAIL = 'ops.admin@stockflow.local';

test.skip(
  ACCESS_TTL_SECONDS === undefined,
  'needs the API started with a short JWT_ACCESS_TTL_SECONDS and E2E_ACCESS_TTL_SECONDS set to match — see this file\'s header comment',
);

test('two tabs whose access token expires together refresh exactly once, and both keep working', async ({ browser }) => {
  const context = await browser.newContext();
  const tab1 = await context.newPage();
  const tab2 = await context.newPage();

  await tab1.goto('/login');
  await tab1.getByLabel('Email').fill(OPS_EMAIL);
  await tab1.getByLabel('Password').fill(SEED_PASSWORD);
  await tab1.getByRole('button', { name: 'Sign in' }).click();
  await expect(tab1).toHaveURL(/\/orders$/);

  // The refresh cookie tab1's login just set is shared by the whole context; tab2
  // hydrates its own in-memory session from it (its own, separate refresh call —
  // not part of what this test counts).
  await tab2.goto('/orders');
  await expect(tab2).toHaveURL(/\/orders$/);

  // Let the short-TTL access token both tabs are holding actually expire.
  await tab1.waitForTimeout(((ACCESS_TTL_SECONDS as number) + 2) * 1000);

  const refreshRequests: string[] = [];
  const trackRefresh = (req: { url: () => string }) => {
    if (req.url().endsWith('/auth/refresh')) refreshRequests.push(req.url());
  };
  tab1.on('request', trackRefresh);
  tab2.on('request', trackRefresh);

  // Both tabs make an authenticated request with their now-expired token at the
  // same time — a real navigation (not page.reload(), which would drop the
  // in-memory token on its own and trigger the initial-hydration path instead of
  // the 401-retry path this test is proving).
  await Promise.all([
    tab1.getByRole('link', { name: 'Inventory' }).click(),
    tab2.getByRole('link', { name: 'Inventory' }).click(),
  ]);

  // Both tabs kept working: neither got logged out by a rotation-reuse false
  // positive from a second, redundant refresh call.
  await expect(tab1).toHaveURL(/\/inventory$/);
  await expect(tab2).toHaveURL(/\/inventory$/);
  await expect(tab1.getByRole('heading', { name: 'Inventory' })).toBeVisible();
  await expect(tab2.getByRole('heading', { name: 'Inventory' })).toBeVisible();

  expect(refreshRequests).toHaveLength(1);

  await context.close();
});
