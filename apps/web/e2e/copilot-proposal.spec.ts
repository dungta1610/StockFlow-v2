import { expect, request as newApiRequest, test } from '@playwright/test';

/**
 * Ask the copilot about stock, let it file an adjustment proposal, approve it, and
 * confirm on the UI that stock changed.
 *
 * **This scenario needs a working model.** It is the one test in the suite that
 * cannot be faked: the point is that a real model chose to call a real tool and
 * then to propose. Everything it would prove with a stubbed model is already
 * proved, deterministically, by the API tests (`test/copilot/*.spec.ts`) and the
 * SSE unit tests (`test/sse-client.spec.ts`).
 *
 * So it is opt-in. Run it once credentials exist:
 *
 *   # .env: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_BEARER_TOKEN_BEDROCK)
 *   docker compose up -d postgres redis litellm
 *   docker compose up migrate
 *   pnpm --filter @stockflow/api start:dev
 *   pnpm --filter @stockflow/web dev
 *   E2E_COPILOT=1 pnpm --filter @stockflow/web test:e2e copilot-proposal
 *
 * Skipped rather than deleted because the gap it covers is real: no other test
 * checks that a model, given these tool descriptions and this system prompt,
 * actually reaches for the right tool.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3100';
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD ?? 'ChangeMe-123!';
const OPS_ADMIN_EMAIL = 'ops.admin@stockflow.local';
// From the seed catalog (apps/api/src/cli/seed-catalog.ts).
const SKU = 'PAPER-A4-70';
const WAREHOUSE_CODE = 'HN-01';

test.skip(
  process.env.E2E_COPILOT !== '1',
  'Needs a model behind LiteLLM (see docs/adr/0003). Set E2E_COPILOT=1 once credentials are configured.',
);

async function stockAt(): Promise<{ inventoryId: string; available: number }> {
  const api = await newApiRequest.newContext({ baseURL: API_URL });
  const login = await api.post('/auth/login', { data: { email: OPS_ADMIN_EMAIL, password: SEED_PASSWORD } });
  const token = ((await login.json()) as { data: { access_token: string } }).data.access_token;
  const auth = { Authorization: `Bearer ${token}` };

  const products = await api.get('/products', { params: { sku: SKU }, headers: auth });
  const productId = ((await products.json()) as { data: { id: string }[] }).data[0]!.id;
  const warehouses = await api.get('/warehouses', { params: { code: WAREHOUSE_CODE }, headers: auth });
  const warehouseId = ((await warehouses.json()) as { data: { id: string }[] }).data[0]!.id;

  const detail = await api.get('/inventories/detail', {
    params: { product_id: productId, warehouse_id: warehouseId },
    headers: auth,
  });
  const body = (await detail.json()) as { data: { id: string; available_qty: number } };
  await api.dispose();
  return { inventoryId: body.data.id, available: body.data.available_qty };
}

test('the copilot proposes a stock adjustment, an ops admin approves it, and stock changes', async ({ page }) => {
  const before = await stockAt();

  await page.goto('/login');
  await page.getByLabel('Email').fill(OPS_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/orders$/);

  await page.getByRole('link', { name: 'Copilot' }).click();
  await expect(page).toHaveURL(/\/copilot$/);

  // First: a plain lookup, to see the tool badge appear while it runs.
  await page.getByLabel('Message').fill(`How much ${SKU} is in ${WAREHOUSE_CODE}?`);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('get inventory status')).toBeVisible({ timeout: 30_000 });

  // Then: ask it to file a correction.
  await expect(page.getByLabel('Message')).toBeEnabled({ timeout: 60_000 });
  await page
    .getByLabel('Message')
    .fill(`A recount of ${SKU} at ${WAREHOUSE_CODE} came up 2 units short. Please propose the correction.`);
  await page.getByRole('button', { name: 'Send' }).click();

  const proposal = page.getByText(`Stock adjustment · ${SKU} at ${WAREHOUSE_CODE}`);
  await expect(proposal).toBeVisible({ timeout: 60_000 });

  // Stock has not moved yet: the whole point of the proposal step.
  await page.goto(`/inventory/${before.inventoryId}`);
  const available = page.locator('dt', { hasText: 'Available' }).locator('xpath=following-sibling::dd[1]');
  await expect(available).toHaveText(String(before.available));

  // Approve it, and see the change land.
  await page.goto('/copilot');
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByText('approved').first()).toBeVisible({ timeout: 15_000 });

  await page.goto(`/inventory/${before.inventoryId}`);
  await expect(available).not.toHaveText(String(before.available));
});
