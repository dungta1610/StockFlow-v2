import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderAction, postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('POST /orders/:id/fulfill', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let ops: string;
  let orderId: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  const consumes = () =>
    withDb(async (pg) =>
      (
        await pg.query(
          `SELECT quantity, before_available_qty, after_available_qty, before_reserved_qty, after_reserved_qty
             FROM commerce.inventory_transactions WHERE txn_type = 'consume'`,
        )
      ).rows,
    );

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    buyer = await bearer(server(), 'buyer@a.test');
    ops = await bearer(server(), 'ops@sf.test');
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, 10);
    orderId = (
      await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 4 }] })
    ).body.data.id;
  });

  it('ships a paid order: reserved drops, available is untouched, the reservation is consumed', async () => {
    await orderAction(server(), ops, orderId, 'mark-paid');
    const res = await orderAction(server(), ops, orderId, 'fulfill');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'fulfilled', fulfilled_at: expect.any(String) });
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 6, reserved_qty: 0 });
    expect(await consumes()).toEqual([
      { quantity: 4, before_available_qty: 6, after_available_qty: 6, before_reserved_qty: 4, after_reserved_qty: 0 },
    ]);
    const reservation = await withDb(async (pg) =>
      (await pg.query('SELECT status, consumed_at FROM commerce.inventory_reservations WHERE order_id = $1', [orderId]))
        .rows[0],
    );
    expect(reservation).toEqual({ status: 'consumed', consumed_at: expect.any(Date) });
  });

  it('is idempotent: a second call consumes nothing more', async () => {
    await orderAction(server(), ops, orderId, 'mark-paid');
    const first = await orderAction(server(), ops, orderId, 'fulfill');
    const second = await orderAction(server(), ops, orderId, 'fulfill');
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await consumes()).toHaveLength(1);
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 6, reserved_qty: 0 });
  });

  it('refuses an order that has not been paid, and a cancelled one', async () => {
    const unpaid = await orderAction(server(), ops, orderId, 'fulfill');
    expect(unpaid.status).toBe(409);
    expect(unpaid.body.error.code).toBe('ORDER_CANNOT_BE_FULFILLED');

    await orderAction(server(), buyer, orderId, 'cancel');
    const cancelled = await orderAction(server(), ops, orderId, 'fulfill');
    expect(cancelled.status).toBe(409);
    expect(await consumes()).toEqual([]);
  });

  it('refuses buyers', async () => {
    await orderAction(server(), ops, orderId, 'mark-paid');
    expect((await orderAction(server(), buyer, orderId, 'fulfill')).status).toBe(403);
  });
});
