import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * StockFlow's CreateOrder never touched stock, so any number of orders could be
 * placed for the last unit. Here 50 buyers race for 10 units.
 *
 * The assertion is on status codes, not only on the final stock: a run where every
 * request failed with a 500 would also leave the totals intact.
 */
describe('no oversell: 50 concurrent orders for 10 units', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
    // Concurrent supertest requests need a server that is already listening.
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

  for (let run = 1; run <= 10; run++) {
    it(`run ${run}: exactly 10 orders succeed and exactly 40 get INSUFFICIENT_STOCK`, async () => {
      const responses = await Promise.all(
        Array.from({ length: 50 }, () =>
          postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] }),
        ),
      );

      const created = responses.filter((r) => r.status === 201);
      const refused = responses.filter((r) => r.status === 409 && r.body.error?.code === 'INSUFFICIENT_STOCK');
      expect(created).toHaveLength(10);
      expect(refused).toHaveLength(40);

      expect(await stockOf(product, warehouse)).toEqual({ available_qty: 0, reserved_qty: 10 });
      const db = await withDb(async (pg) => ({
        reserves: Number(
          (await pg.query("SELECT count(*) AS n FROM commerce.inventory_transactions WHERE txn_type = 'reserve'"))
            .rows[0].n,
        ),
        held: Number(
          (await pg.query("SELECT count(*) AS n FROM commerce.inventory_reservations WHERE status = 'held'")).rows[0]
            .n,
        ),
        orders: Number((await pg.query('SELECT count(*) AS n FROM commerce.orders')).rows[0].n),
      }));
      expect(db).toEqual({ reserves: 10, held: 10, orders: 10 });
    });
  }
});
