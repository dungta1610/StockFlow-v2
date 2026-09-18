import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderAction, postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('repeating cancel or expire', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let ops: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  const releases = () =>
    withDb(async (pg) =>
      Number(
        (await pg.query("SELECT count(*) AS n FROM commerce.inventory_transactions WHERE txn_type = 'release'"))
          .rows[0].n,
      ),
    );
  const place = async () =>
    (await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 4 }] })).body
      .data.id as string;

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
    await stockUp(app, t, product, warehouse, 20);
  });

  it('a second cancel returns the same result and releases nothing more', async () => {
    const id = await place();
    const first = await orderAction(server(), buyer, id, 'cancel');
    const second = await orderAction(server(), buyer, id, 'cancel');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await releases()).toBe(1);
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 20, reserved_qty: 0 });
  });

  it('a second expire returns the same result and releases nothing more', async () => {
    const id = await place();
    const first = await orderAction(server(), ops, id, 'expire');
    const second = await orderAction(server(), ops, id, 'expire');

    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ status: 'expired', expired_at: expect.any(String) });
    expect(second.body).toEqual(first.body);
    expect(await releases()).toBe(1);
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 20, reserved_qty: 0 });
  });

  it('cancelling an expired order returns it unchanged and releases nothing twice', async () => {
    const id = await place();
    const expired = await orderAction(server(), ops, id, 'expire');
    const cancel = await orderAction(server(), buyer, id, 'cancel');

    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toEqual(expired.body.data);
    expect(await releases()).toBe(1);
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 20, reserved_qty: 0 });
  });

  it('expiring a cancelled order returns it unchanged', async () => {
    const id = await place();
    await orderAction(server(), buyer, id, 'cancel');
    const expire = await orderAction(server(), ops, id, 'expire');

    expect(expire.status).toBe(200);
    expect(expire.body.data.status).toBe('cancelled');
    expect(await releases()).toBe(1);
  });

  it('only ops may expire an order by hand', async () => {
    const id = await place();
    expect((await orderAction(server(), buyer, id, 'expire')).status).toBe(403);
  });
});
