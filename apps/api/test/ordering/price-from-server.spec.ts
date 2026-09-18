import type { INestApplication } from '@nestjs/common';
import { insertPriceList, insertProduct, insertTier, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/** StockFlow charged whatever unit_price the client sent. */
describe('order prices come from the server', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let paper: string;
  let pen: string;
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
      paper = await insertProduct(pg, { sku: 'PAPER', basePrice: '60000' });
      pen = await insertProduct(pg, { sku: 'PEN', basePrice: '5000.50' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
      const contract = await insertPriceList(pg, { orgId: t.buyerA, name: 'A' });
      await insertTier(pg, { listId: contract, productId: paper, unitPrice: '48000' });
    });
    await stockUp(app, t, paper, warehouse, 100);
    await stockUp(app, t, pen, warehouse, 100);
  });

  it('ignores unit_price, line_total and total sent by the client', async () => {
    const res = await postOrder(server(), buyer, {
      warehouse_id: warehouse,
      total: '1.00',
      items: [
        { product_id: paper, quantity: 3, unit_price: '0', line_total: '0' },
        { product_id: pen, quantity: 2, unit_price: '999999' },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'reserved',
      currency: 'VND',
      subtotal: '154001.00',
      total: '154001.00',
      items: [
        { sku: 'PAPER', quantity: 3, unit_price: '48000.00', line_total: '144000.00' },
        { sku: 'PEN', quantity: 2, unit_price: '5000.50', line_total: '10001.00' },
      ],
    });

    const stored = await withDb(async (pg) => ({
      items: (
        await pg.query(
          'SELECT unit_price, line_total FROM commerce.order_items WHERE order_id = $1 ORDER BY unit_price DESC',
          [res.body.data.id],
        )
      ).rows,
      order: (await pg.query('SELECT subtotal, total FROM commerce.orders WHERE id = $1', [res.body.data.id])).rows[0],
    }));
    expect(stored.items).toEqual([
      { unit_price: '48000.00', line_total: '144000.00' },
      { unit_price: '5000.50', line_total: '10001.00' },
    ]);
    expect(stored.order).toEqual({ subtotal: '154001.00', total: '154001.00' });
  });
});
