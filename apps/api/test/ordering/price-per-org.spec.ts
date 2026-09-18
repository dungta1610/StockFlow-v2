import type { INestApplication } from '@nestjs/common';
import { insertPriceList, insertProduct, insertTier, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('two customers ordering the same product', () => {
  let app: INestApplication;
  let t: Tenants;
  let paper: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    await withDb(async (pg) => {
      paper = await insertProduct(pg, { sku: 'PAPER', basePrice: '60000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
      const a = await insertPriceList(pg, { orgId: t.buyerA, name: 'A' });
      const b = await insertPriceList(pg, { orgId: t.buyerB, name: 'B' });
      await insertTier(pg, { listId: a, productId: paper, unitPrice: '50000' });
      await insertTier(pg, { listId: b, productId: paper, unitPrice: '42000' });
    });
    await stockUp(app, t, paper, warehouse, 100);
  });

  it('pays each its own contract price', async () => {
    const body = { warehouse_id: warehouse, items: [{ product_id: paper, quantity: 4 }] };
    const a = await postOrder(server(), await bearer(server(), 'buyer@a.test'), body);
    const b = await postOrder(server(), await bearer(server(), 'buyer@b.test'), body);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data).toMatchObject({ buyer_org_id: t.buyerA, total: '200000.00' });
    expect(a.body.data.items[0].unit_price).toBe('50000.00');
    expect(b.body.data).toMatchObject({ buyer_org_id: t.buyerB, total: '168000.00' });
    expect(b.body.data.items[0].unit_price).toBe('42000.00');
  });
});
