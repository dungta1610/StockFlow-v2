import type { INestApplication } from '@nestjs/common';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * Group A orders [SKU1, SKU2], group B orders [SKU2, SKU1]. Reserving lines in the
 * order the buyer listed them would let an A and a B each lock one row and wait for
 * the other. Lines are reserved sorted by product id, so every order locks in the
 * same order and no request fails.
 */
describe('orders buying the same products in opposite order', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let sku1: string;
  let sku2: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    buyer = await bearer(server(), 'buyer@a.test');
    await withDb(async (pg) => {
      sku1 = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      sku2 = await insertProduct(pg, { sku: 'SKU-2', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, sku1, warehouse, 100);
    await stockUp(app, t, sku2, warehouse, 100);
  });

  it('all 40 succeed: none is aborted as a deadlock victim', async () => {
    const order = (first: string, second: string) =>
      postOrder(server(), buyer, {
        warehouse_id: warehouse,
        items: [
          { product_id: first, quantity: 1 },
          { product_id: second, quantity: 1 },
        ],
      });
    const responses = await Promise.all([
      ...Array.from({ length: 20 }, () => order(sku1, sku2)),
      ...Array.from({ length: 20 }, () => order(sku2, sku1)),
    ]);

    expect(responses.map((r) => r.status)).toEqual(Array(40).fill(201));
    expect(await stockOf(sku1, warehouse)).toEqual({ available_qty: 60, reserved_qty: 40 });
    expect(await stockOf(sku2, warehouse)).toEqual({ available_qty: 60, reserved_qty: 40 });
  });
});
