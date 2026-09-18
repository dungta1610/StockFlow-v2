import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderAction, postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/** StockFlow's CancelOrder only changed the status; the stock stayed held forever. */
describe('cancelling an order gives its stock back', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

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
    await stockUp(app, t, product, warehouse, 20);
  });

  it('holds 5 on create and returns exactly 5 on cancel', async () => {
    const created = await postOrder(server(), buyer, {
      warehouse_id: warehouse,
      items: [{ product_id: product, quantity: 5 }],
    });
    expect(created.status).toBe(201);
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 15, reserved_qty: 5 });

    const cancelled = await orderAction(server(), buyer, created.body.data.id, 'cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', cancelled_at: expect.any(String) });
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 20, reserved_qty: 0 });

    const db = await withDb(async (pg) => ({
      reservations: (
        await pg.query('SELECT id, status, released_at FROM commerce.inventory_reservations WHERE order_id = $1', [
          created.body.data.id,
        ])
      ).rows,
      releases: (
        await pg.query(
          `SELECT order_id, reservation_id, quantity, before_available_qty, after_available_qty,
                  before_reserved_qty, after_reserved_qty
             FROM commerce.inventory_transactions WHERE txn_type = 'release'`,
        )
      ).rows,
    }));
    expect(db.reservations).toEqual([{ id: expect.any(String), status: 'released', released_at: expect.any(Date) }]);
    expect(db.releases).toEqual([
      {
        order_id: created.body.data.id,
        reservation_id: db.reservations[0].id,
        quantity: 5,
        before_available_qty: 15,
        after_available_qty: 20,
        before_reserved_qty: 5,
        after_reserved_qty: 0,
      },
    ]);
  });
});
