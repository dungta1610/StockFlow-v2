import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderAction, postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('outbox events are written with the change they describe', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();
  const events = () =>
    withDb(async (pg) =>
      (
        await pg.query(
          'SELECT aggregate_type, aggregate_id, event_type, org_id, status, attempts, payload FROM commerce.outbox_events ORDER BY id',
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
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, 3);
  });

  it('a created order has exactly one pending order.created event owned by the buyer', async () => {
    const res = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(await events()).toEqual([
      {
        aggregate_type: 'order',
        aggregate_id: res.body.data.id,
        event_type: 'order.created',
        org_id: t.buyerA,
        status: 'pending',
        attempts: 0,
        payload: expect.objectContaining({ order_code: res.body.data.order_code, total: '2000.00' }),
      },
    ]);
  });

  it('a failed order leaves no event', async () => {
    const res = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 4 }] });
    expect(res.status).toBe(409);
    expect(await events()).toEqual([]);
  });

  it('an ops cancel is still owned by the buyer organisation', async () => {
    const res = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] });
    await orderAction(server(), await bearer(server(), 'ops@sf.test'), res.body.data.id, 'cancel');
    const cancelled = (await events()).filter((e) => e.event_type === 'order.cancelled');
    expect(cancelled).toEqual([
      expect.objectContaining({
        org_id: t.buyerA,
        payload: expect.objectContaining({ from: 'reserved', to: 'cancelled', actor_user_id: t.users.ops }),
      }),
    ]);
  });
});
