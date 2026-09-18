import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderAction, postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/** Records a payment received outside the system (there is no payment module in v1). */
describe('POST /orders/:id/mark-paid', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let ops: string;
  let orderId: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  const paidEvents = () =>
    withDb(async (pg) =>
      (
        await pg.query(
          "SELECT aggregate_id, org_id, status, payload FROM commerce.outbox_events WHERE event_type = 'order.paid'",
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
      await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 3 }] })
    ).body.data.id;
  });

  it('moves a reserved order to paid, stamps paid_at and records order.paid', async () => {
    const res = await orderAction(server(), ops, orderId, 'mark-paid');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'paid', paid_at: expect.any(String) });
    expect(await paidEvents()).toEqual([
      { aggregate_id: orderId, org_id: t.buyerA, status: 'pending', payload: expect.objectContaining({ from: 'reserved', to: 'paid' }) },
    ]);
    // Paying does not move stock: it stays held until the order ships.
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 7, reserved_qty: 3 });
  });

  it('refuses buyers', async () => {
    const res = await orderAction(server(), buyer, orderId, 'mark-paid');
    expect(res.status).toBe(403);
    expect(await paidEvents()).toEqual([]);
  });

  it('is idempotent: a second call returns the same order and records nothing new', async () => {
    const first = await orderAction(server(), ops, orderId, 'mark-paid');
    const second = await orderAction(server(), ops, orderId, 'mark-paid');
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await paidEvents()).toHaveLength(1);
  });

  it('a paid order can no longer be cancelled', async () => {
    await orderAction(server(), ops, orderId, 'mark-paid');
    const res = await orderAction(server(), buyer, orderId, 'cancel');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_CANNOT_BE_CANCELLED');
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 7, reserved_qty: 3 });
  });

  it('a cancelled order cannot be paid', async () => {
    await orderAction(server(), buyer, orderId, 'cancel');
    const res = await orderAction(server(), ops, orderId, 'mark-paid');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_CANNOT_BE_PAID');
  });
});
