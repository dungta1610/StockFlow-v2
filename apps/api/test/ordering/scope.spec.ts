import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderAction, postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('orders are scoped to the buyer organisation', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyerA: string;
  let buyerB: string;
  let ops: string;
  let orderA: { id: string; order_code: string };
  let orderB: { id: string };
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();
  const get = (path: string, auth: string) => request(server()).get(path).set('Authorization', auth);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    [buyerA, buyerB, ops] = await Promise.all([
      bearer(server(), 'buyer@a.test'),
      bearer(server(), 'buyer@b.test'),
      bearer(server(), 'ops@sf.test'),
    ]);
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, 10);
    const body = { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] };
    orderA = (await postOrder(server(), buyerA, body)).body.data;
    orderB = (await postOrder(server(), buyerB, body)).body.data;
  });

  it('a buyer lists only their own orders', async () => {
    const res = await get('/orders', buyerA);
    expect(res.status).toBe(200);
    expect(res.body.data.map((o: { id: string }) => o.id)).toEqual([orderA.id]);
    expect(res.body.paging).toEqual({ page: 1, limit: 10 });

    // Naming another organisation does not widen the scope.
    const other = await get(`/orders?buyer_org_id=${t.buyerB}`, buyerA);
    expect(other.body.data).toEqual([]);
  });

  it('a buyer cannot read or cancel another organisation’s order: 404, not 403', async () => {
    const read = await get(`/orders/${orderB.id}`, buyerA);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('ORDER_NOT_FOUND');

    const cancel = await orderAction(server(), buyerA, orderB.id, 'cancel');
    expect(cancel.status).toBe(404);
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 8, reserved_qty: 2 });
  });

  it('a buyer reads their own order with its lines', async () => {
    const res = await get(`/orders/${orderA.id}`, buyerA);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: orderA.id, items: [{ sku: 'SKU-1', quantity: 1 }] });
  });

  it('ops see every buyer’s orders and can narrow by customer, status and code', async () => {
    const all = await get('/orders', ops);
    expect(all.body.data.map((o: { id: string }) => o.id).sort()).toEqual([orderA.id, orderB.id].sort());

    const onlyA = await get(`/orders?buyer_org_id=${t.buyerA}`, ops);
    expect(onlyA.body.data.map((o: { id: string }) => o.id)).toEqual([orderA.id]);

    const byCode = await get(`/orders?order_code=${orderA.order_code.toLowerCase()}`, ops);
    expect(byCode.body.data.map((o: { id: string }) => o.id)).toEqual([orderA.id]);

    const cancelled = await get('/orders?status=cancelled', ops);
    expect(cancelled.body.data).toEqual([]);

    expect((await get(`/orders/${orderB.id}`, ops)).status).toBe(200);
  });

  it('ops cannot place orders', async () => {
    const res = await postOrder(server(), ops, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] });
    expect(res.status).toBe(403);
  });

  it('rejects an id that is not a uuid', async () => {
    expect((await get('/orders/not-a-uuid', buyerA)).status).toBe(400);
  });
});
