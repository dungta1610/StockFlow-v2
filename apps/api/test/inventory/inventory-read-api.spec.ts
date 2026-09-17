import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

// StockFlow GET /inventories/detail and /inventories/transactions, plus a list
// endpoint for the ops console. Stock levels are supplier data: buyers never see them.
describe('inventory read endpoints', () => {
  let app: INestApplication;
  let ops: string;
  let buyer: string;
  let products: string[];
  let warehouses: string[];
  const server = () => app.getHttpServer();
  const get = (path: string, auth = ops) => request(server()).get(path).set('Authorization', auth);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await seedTenants();
    [ops, buyer] = await Promise.all([bearer(server(), 'ops@sf.test'), bearer(server(), 'buyer@a.test')]);
    await withDb(async (pg) => {
      products = [
        await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' }),
        await insertProduct(pg, { sku: 'SKU-2', basePrice: '2000' }),
      ];
      warehouses = [await insertWarehouse(pg, { code: 'HN-01' }), await insertWarehouse(pg, { code: 'HCM-01' })];
    });
    for (const product of products) {
      for (const warehouse of warehouses) {
        await request(server())
          .post('/inventories/adjust')
          .set('Authorization', ops)
          .send({ product_id: product, warehouse_id: warehouse, quantity: 10 });
      }
    }
  });

  it('lists stock with paging and filters by product and warehouse', async () => {
    const all = await get('/inventories');
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(4);
    expect(all.body.paging).toEqual({ page: 1, limit: 10 });
    expect(all.body.data[0]).toMatchObject({ available_qty: 10, reserved_qty: 0, version: 1 });

    const byProduct = await get(`/inventories?product_id=${products[0]}`);
    expect(byProduct.body.data.map((i: { sku: string }) => i.sku)).toEqual(['SKU-1', 'SKU-1']);
    const byWarehouse = await get(`/inventories?warehouse_id=${warehouses[1]}`);
    expect(byWarehouse.body.data.every((i: { warehouse_code: string }) => i.warehouse_code === 'HCM-01')).toBe(true);
  });

  it('reads one row by product and warehouse, or by id', async () => {
    const detail = await get(`/inventories/detail?product_id=${products[0]}&warehouse_id=${warehouses[0]}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ sku: 'SKU-1', warehouse_code: 'HN-01', available_qty: 10 });

    const byId = await get(`/inventories/detail?id=${detail.body.data.id}`);
    expect(byId.body.data.id).toBe(detail.body.data.id);
  });

  it('404s for a pair that has never been stocked and 400s without a usable query', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const res = await get(`/inventories/detail?product_id=${products[0]}&warehouse_id=${missing}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INVENTORY_NOT_FOUND');
    expect((await get('/inventories/detail')).status).toBe(400);
    expect((await get(`/inventories/detail?product_id=${products[0]}`)).status).toBe(400);
  });

  it('lists ledger rows newest first and filters them', async () => {
    const all = await get('/inventories/transactions');
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(4);
    expect(all.body.data[0]).toMatchObject({ txn_type: 'manual_adjustment', quantity: 10 });

    const byProduct = await get(`/inventories/transactions?product_id=${products[1]}`);
    expect(byProduct.body.data).toHaveLength(2);
    const byType = await get('/inventories/transactions?txn_type=reserve');
    expect(byType.body.data).toEqual([]);
    expect((await get('/inventories/transactions?txn_type=nonsense')).status).toBe(400);
  });

  it('keeps stock levels away from buyers', async () => {
    expect((await get('/inventories', buyer)).status).toBe(403);
    expect((await get(`/inventories/detail?id=${products[0]}`, buyer)).status).toBe(403);
    expect((await get('/inventories/transactions', buyer)).status).toBe(403);
  });
});
