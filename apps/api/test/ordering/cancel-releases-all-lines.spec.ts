import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderAction, postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * Releasing reservations in batches with a LIMIT would release part of a multi-line
 * order and then treat the order as done. Cancel settles the whole order.
 */
describe('cancelling a three-line order', () => {
  let app: INestApplication;
  let t: Tenants;
  let ops: string;
  let products: string[];
  let warehouse: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    ops = await bearer(server(), 'ops@sf.test');
    await withDb(async (pg) => {
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
      products = [
        await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' }),
        await insertProduct(pg, { sku: 'SKU-2', basePrice: '1000' }),
        await insertProduct(pg, { sku: 'SKU-3', basePrice: '1000' }),
      ];
    });
    for (const p of products) await stockUp(app, t, p, warehouse, 10);
  });

  it('releases all three lines', async () => {
    const buyer = await bearer(server(), 'buyer@a.test');
    const created = await postOrder(server(), buyer, {
      warehouse_id: warehouse,
      items: products.map((p, i) => ({ product_id: p, quantity: i + 1 })),
    });
    expect(created.status).toBe(201);

    const res = await orderAction(server(), ops, created.body.data.id, 'cancel');
    expect(res.status).toBe(200);

    for (const p of products) expect(await stockOf(p, warehouse)).toEqual({ available_qty: 10, reserved_qty: 0 });
    const statuses = await withDb(async (pg) =>
      (
        await pg.query('SELECT status FROM commerce.inventory_reservations WHERE order_id = $1', [
          created.body.data.id,
        ])
      ).rows.map((r) => r.status),
    );
    expect(statuses).toEqual(['released', 'released', 'released']);
  });
});
