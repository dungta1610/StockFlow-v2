import { expect, request as newApiRequest, test } from '@playwright/test';

/**
 * Login as ops -> open an order -> cancel -> confirm on the UI that the stock came
 * back. Needs the full local stack running:
 *
 *   docker compose up -d postgres redis
 *   docker compose up migrate                 # applies migrations + seeds demo data
 *   pnpm --filter @stockflow/api start:dev     # or: docker compose up -d api
 *   pnpm --filter @stockflow/web dev           # or: docker compose up -d web
 *
 * Then, from apps/web:
 *   pnpm exec playwright install chromium      # once, downloads the browser binary
 *   E2E_BASE_URL=http://localhost:5173 E2E_API_URL=http://localhost:3100 pnpm test:e2e
 *
 * (Defaults already point at the host-run dev servers above; only override them for
 * the `docker compose up -d web` variant, which serves on :8080.)
 *
 * The order under test is placed directly through the API (not the UI) so the
 * scenario stays focused on the ops cancel-and-verify flow the phase asks for; the
 * UI itself is exercised for login, opening the order, cancelling and re-reading
 * stock.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3100';
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD ?? 'ChangeMe-123!';
const BUYER_EMAIL = 'admin@buyer-a.local';
const OPS_EMAIL = 'ops.admin@stockflow.local';
// From the seed catalog (apps/api/src/cli/seed-catalog.ts): plenty of stock at HN-01.
const SKU = 'PAPER-A4-70';
const WAREHOUSE_CODE = 'HN-01';

interface Setup {
  orderCode: string;
  inventoryId: string;
  availableBeforeCancel: number;
  availableBeforeOrder: number;
}

async function seedOrder(): Promise<Setup> {
  const api = await newApiRequest.newContext({ baseURL: API_URL });
  const login = async (email: string) => {
    const res = await api.post('/auth/login', { data: { email, password: SEED_PASSWORD } });
    if (!res.ok()) throw new Error(`login failed for ${email}: ${res.status()} ${await res.text()}`);
    return ((await res.json()) as { data: { access_token: string } }).data.access_token;
  };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const buyerToken = await login(BUYER_EMAIL);
  const opsToken = await login(OPS_EMAIL);

  const products = await api.get('/products', { params: { sku: SKU }, headers: auth(opsToken) });
  const productId = ((await products.json()) as { data: { id: string }[] }).data[0]?.id;
  if (!productId) throw new Error(`seed product ${SKU} not found — has \`pnpm seed\` run?`);

  const warehouses = await api.get('/warehouses', { params: { code: WAREHOUSE_CODE }, headers: auth(opsToken) });
  const warehouseId = ((await warehouses.json()) as { data: { id: string }[] }).data[0]?.id;
  if (!warehouseId) throw new Error(`seed warehouse ${WAREHOUSE_CODE} not found — has \`pnpm seed\` run?`);

  const before = await api.get('/inventories/detail', {
    params: { product_id: productId, warehouse_id: warehouseId },
    headers: auth(opsToken),
  });
  const beforeBody = (await before.json()) as { data: { id: string; available_qty: number } };
  const availableBeforeOrder = beforeBody.data.available_qty;
  const inventoryId = beforeBody.data.id;

  const order = await api.post('/orders', {
    headers: auth(buyerToken),
    data: { warehouse_id: warehouseId, items: [{ product_id: productId, quantity: 1 }] },
  });
  if (!order.ok()) throw new Error(`order placement failed: ${order.status()} ${await order.text()}`);
  const orderCode = ((await order.json()) as { data: { order_code: string } }).data.order_code;

  const after = await api.get('/inventories/detail', {
    params: { product_id: productId, warehouse_id: warehouseId },
    headers: auth(opsToken),
  });
  const availableBeforeCancel = ((await after.json()) as { data: { available_qty: number } }).data.available_qty;
  expect(availableBeforeCancel).toBe(availableBeforeOrder - 1);

  await api.dispose();
  return { orderCode, inventoryId, availableBeforeCancel, availableBeforeOrder };
}

test('ops cancels a reserved order and the UI shows the stock returned', async ({ page }) => {
  const setup = await seedOrder();

  await page.goto('/login');
  await page.getByLabel('Email').fill(OPS_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/orders$/);

  // Find the order and open it.
  await page.getByPlaceholder(/Order code/i).fill(setup.orderCode);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: setup.orderCode }).click();
  await expect(page).toHaveURL(/\/orders\//);
  // The state machine's current-step node (there is only ever one) — not a plain
  // text match, which the "reserved"/"cancelled" side-exit labels in the diagram
  // itself would also satisfy regardless of which status is actually current.
  await expect(page.locator('[aria-current="step"]')).toHaveText('reserved');

  // Cancel it, accepting the confirm() dialog.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('[aria-current="step"]')).toHaveText('cancelled');

  // The reservations panel on the order itself already shows the hold released.
  await expect(page.getByRole('cell', { name: 'released' })).toBeVisible();

  // And the stock is visibly back on the Inventory screen.
  await page.goto(`/inventory/${setup.inventoryId}`);
  const available = page.locator('dt', { hasText: 'Available' }).locator('xpath=following-sibling::dd[1]');
  await expect(available).toHaveText(String(setup.availableBeforeOrder));
});
