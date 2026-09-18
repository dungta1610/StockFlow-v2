import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderFootprint, postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('Idempotency-Key on POST /orders', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();
  const body = (quantity = 2) => ({ warehouse_id: warehouse, items: [{ product_id: product, quantity }] });

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
    await stockUp(app, t, product, warehouse, 10);
  });

  it('replays the original response for the same key and body, creating one order', async () => {
    const first = await postOrder(server(), buyer, body(), 'key-1');
    const second = await postOrder(server(), buyer, body(), 'key-1');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect((await orderFootprint()).orders).toBe(1);
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 8, reserved_qty: 2 });
  });

  it('refuses the same key with a different body', async () => {
    await postOrder(server(), buyer, body(2), 'key-1');
    const res = await postOrder(server(), buyer, body(3), 'key-1');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await orderFootprint()).orders).toBe(1);
  });

  it('scopes keys to the organisation: another buyer may use the same key', async () => {
    await postOrder(server(), buyer, body(), 'shared');
    const other = await postOrder(server(), await bearer(server(), 'buyer@b.test'), body(), 'shared');
    expect(other.status).toBe(201);
    expect(other.body.data.buyer_org_id).toBe(t.buyerB);
    expect((await orderFootprint()).orders).toBe(2);
  });

  it('without a key, every request is a new order', async () => {
    await postOrder(server(), buyer, body(1));
    await postOrder(server(), buyer, body(1));
    expect((await orderFootprint()).orders).toBe(2);
  });

  it('rejects a malformed key', async () => {
    const res = await postOrder(server(), buyer, body(), 'has space');
    expect(res.status).toBe(400);
  });
});
