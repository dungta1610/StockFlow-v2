import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderFootprint, postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('an order that cannot reserve its last line', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let warehouse: string;
  /** Sorted by id, so the short line is the last one reserved. */
  let products: string[];
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    buyer = await bearer(server(), 'buyer@a.test');
    await withDb(async (pg) => {
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
      const ids = [
        await insertProduct(pg, { sku: 'SKU-A', basePrice: '1000' }),
        await insertProduct(pg, { sku: 'SKU-B', basePrice: '1000' }),
        await insertProduct(pg, { sku: 'SKU-C', basePrice: '1000' }),
      ];
      products = ids.sort();
    });
    await stockUp(app, t, products[0]!, warehouse, 10);
    await stockUp(app, t, products[1]!, warehouse, 10);
    await stockUp(app, t, products[2]!, warehouse, 1);
  });

  it('rolls back the lines already reserved and leaves no row behind', async () => {
    const before = await orderFootprint();
    const res = await postOrder(server(), buyer, {
      warehouse_id: warehouse,
      items: [
        { product_id: products[0]!, quantity: 5 },
        { product_id: products[1]!, quantity: 5 },
        { product_id: products[2]!, quantity: 2 },
      ],
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.error.details).toEqual({ product_id: products[2], sku: expect.any(String), requested: 2, available: 1 });

    expect(await stockOf(products[0]!, warehouse)).toEqual({ available_qty: 10, reserved_qty: 0 });
    expect(await stockOf(products[1]!, warehouse)).toEqual({ available_qty: 10, reserved_qty: 0 });
    expect(await stockOf(products[2]!, warehouse)).toEqual({ available_qty: 1, reserved_qty: 0 });
    expect(await orderFootprint()).toEqual(before);
    expect(before).toEqual({ orders: 0, order_items: 0, reservations: 0, order_ledger: 0, outbox: 0 });
  });

  it('names the missing product even when it was never stocked in that warehouse', async () => {
    const unstocked = await withDb((pg) => insertProduct(pg, { sku: 'SKU-NONE', basePrice: '1000' }));
    const res = await postOrder(server(), buyer, {
      warehouse_id: warehouse,
      items: [{ product_id: unstocked, quantity: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ product_id: unstocked, sku: 'SKU-NONE', requested: 1, available: 0 });
  });
});
