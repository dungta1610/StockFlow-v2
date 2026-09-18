import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderFootprint, postOrder, sleep, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';
import { Client } from 'pg';

/**
 * Two requests with one key at the same moment. The key is claimed in its own
 * committed statement before the order work starts, so the second request sees the
 * claim at once — it gets a meaningful 409, not an empty body and not a second order.
 */
describe('two requests with the same Idempotency-Key in flight together', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();
  const body = () => ({ warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] });

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    buyer = await bearer(server(), 'buyer@a.test');
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, 10);
  });

  it('while the first is still working, the second gets 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    // Hold the stock row so the first request stops inside its order transaction.
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM commerce.inventory WHERE product_id = $1 FOR UPDATE', [product]);

      const first = postOrder(server(), buyer, body(), 'same-key').then((r) => r);
      // Wait until the first request has claimed the key.
      for (let i = 0; i < 100; i++) {
        const { rows } = await holder.query(
          "SELECT 1 FROM commerce.idempotency_keys WHERE key = 'same-key' AND status = 'in_progress'",
        );
        if (rows.length > 0) break;
        await sleep(20);
      }

      const second = await postOrder(server(), buyer, body(), 'same-key');
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(second.headers['retry-after']).toBe('1');

      await holder.query('COMMIT');
      const firstRes = await first;
      expect(firstRes.status).toBe(201);
    } finally {
      await holder.end();
    }
    expect((await orderFootprint()).orders).toBe(1);
  });

  it('fired together, they produce exactly one order', async () => {
    const [a, b] = await Promise.all([
      postOrder(server(), buyer, body(), 'race'),
      postOrder(server(), buyer, body(), 'race'),
    ]);
    const statuses = [a.status, b.status].sort();
    // The loser either saw the claim (409) or arrived after the winner finished (replay).
    expect([[201, 409], [201, 201]]).toContainEqual(statuses);
    for (const loser of [a, b].filter((r) => r.status === 409)) {
      expect(loser.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    }
    expect((await orderFootprint()).orders).toBe(1);
  });
});
