import type { INestApplication } from '@nestjs/common';
import { insertPriceList, insertProduct, insertTier, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('each order line records where its price came from', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyer: string;
  let paper: string;
  let pen: string;
  let tier: string;
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
      pen = await insertProduct(pg, { sku: 'PEN', basePrice: '5000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
      const contract = await insertPriceList(pg, { orgId: t.buyerA, name: 'A' });
      await insertTier(pg, { listId: contract, productId: paper, unitPrice: '50000' });
      tier = await insertTier(pg, { listId: contract, productId: paper, minQty: 10, unitPrice: '45000' });
    });
    await stockUp(app, t, paper, warehouse, 100);
    await stockUp(app, t, pen, warehouse, 100);
  });

  it('points at the tier that priced the line, and is null when the base price applied', async () => {
    const res = await postOrder(server(), buyer, {
      warehouse_id: warehouse,
      items: [
        { product_id: paper, quantity: 12 },
        { product_id: pen, quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);

    const rows = await withDb(async (pg) =>
      (
        await pg.query(
          `SELECT p.sku, oi.unit_price, oi.price_list_item_id
             FROM commerce.order_items oi JOIN commerce.products p ON p.id = oi.product_id
            WHERE oi.order_id = $1 ORDER BY p.sku`,
          [res.body.data.id],
        )
      ).rows,
    );
    expect(rows).toEqual([
      { sku: 'PAPER', unit_price: '45000.00', price_list_item_id: tier },
      { sku: 'PEN', unit_price: '5000.00', price_list_item_id: null },
    ]);
    expect(res.body.data.items.map((i: { price_list_item_id: string | null }) => i.price_list_item_id)).toEqual([
      tier,
      null,
    ]);
  });
});
