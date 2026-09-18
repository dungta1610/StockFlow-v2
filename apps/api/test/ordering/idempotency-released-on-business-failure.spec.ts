import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderFootprint, postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * INSUFFICIENT_STOCK is exactly when a client should fix the cart and try again. A
 * failed attempt frees its key; only a success locks it.
 */
describe('an idempotency key whose request failed for lack of stock', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();
  const body = (quantity: number) => ({ warehouse_id: warehouse, items: [{ product_id: product, quantity }] });
  const keyStatus = () =>
    withDb(async (pg) => (await pg.query("SELECT status FROM commerce.idempotency_keys WHERE key = 'cart-1'")).rows[0]?.status);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    buyer = await bearer(server(), 'buyer@a.test');
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, 1);
  });

  it('is marked failed and accepts a corrected retry with the same key', async () => {
    const failed = await postOrder(server(), buyer, body(2), 'cart-1');
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await keyStatus()).toBe('failed');

    const retried = await postOrder(server(), buyer, body(1), 'cart-1');
    expect(retried.status).toBe(201);
    expect(await keyStatus()).toBe('completed');

    // From here the key belongs to the successful order.
    const replay = await postOrder(server(), buyer, body(1), 'cart-1');
    expect(replay.body).toEqual(retried.body);
    const changed = await postOrder(server(), buyer, body(2), 'cart-1');
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await orderFootprint()).orders).toBe(1);
  });
});
