import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb } from '../helpers/identity-fixtures';
import { AdjustStockUseCase } from '../../src/modules/inventory/application/use-cases/adjust-stock.use-case';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { createTestApp } from '../helpers/test-app';

// StockFlow POST /inventories/adjust: a signed delta that creates the row when the
// product/warehouse pair has never been stocked. Every successful adjust also writes
// exactly one ledger row.
describe('POST /inventories/adjust', () => {
  let app: INestApplication;
  let ops: string;
  let opsAdmin: string;
  let buyer: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  const adjust = (body: object, auth = ops) =>
    request(server()).post('/inventories/adjust').set('Authorization', auth).send(body);

  const levels = () =>
    withDb(async (pg) => {
      const inventory = await pg.query('SELECT * FROM commerce.inventory');
      const ledger = await pg.query('SELECT * FROM commerce.inventory_transactions ORDER BY created_at, id');
      return { inventory: inventory.rows, ledger: ledger.rows };
    });

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await seedTenants();
    [ops, opsAdmin, buyer] = await Promise.all([
      bearer(server(), 'ops@sf.test'),
      bearer(server(), 'ops.admin@sf.test'),
      bearer(server(), 'buyer@a.test'),
    ]);
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
  });

  it('creates the row on the first adjust and records it in the ledger', async () => {
    const res = await adjust({ product_id: product, warehouse_id: warehouse, quantity: 100, reason: 'nhập kho' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      product_id: product,
      sku: 'SKU-1',
      warehouse_id: warehouse,
      warehouse_code: 'HN-01',
      available_qty: 100,
      reserved_qty: 0,
    });

    const { inventory, ledger } = await levels();
    expect(inventory).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      inventory_id: inventory[0].id,
      product_id: product,
      warehouse_id: warehouse,
      txn_type: 'manual_adjustment',
      quantity: 100,
      before_available_qty: 0,
      after_available_qty: 100,
      before_reserved_qty: 0,
      after_reserved_qty: 0,
      reason: 'nhập kho',
      order_id: null,
      reservation_id: null,
    });
  });

  it('records who made the adjustment', async () => {
    await adjust({ product_id: product, warehouse_id: warehouse, quantity: 5 });
    const { ledger } = await levels();
    const { rows } = await withDb((pg) =>
      pg.query(`SELECT id FROM commerce.users WHERE email = 'ops@sf.test'`),
    );
    expect(ledger[0].created_by).toBe(rows[0].id);
  });

  it('adds to an existing row and writes one ledger row per adjust', async () => {
    await adjust({ product_id: product, warehouse_id: warehouse, quantity: 100 });
    const res = await adjust({ product_id: product, warehouse_id: warehouse, quantity: -30, reason: 'xuất kho' });
    expect(res.status).toBe(200);
    expect(res.body.data.available_qty).toBe(70);

    const { inventory, ledger } = await levels();
    expect(inventory).toHaveLength(1);
    expect(inventory[0].available_qty).toBe(70);
    expect(inventory[0].version).toBe(2);
    expect(ledger).toHaveLength(2);
    // The ledger stores the size of the move, and the direction is in before/after.
    expect(ledger[1]).toMatchObject({
      quantity: 30,
      before_available_qty: 100,
      after_available_qty: 70,
      reason: 'xuất kho',
    });
    expect(ledger[1].after_available_qty).toBe(inventory[0].available_qty);
  });

  describe('refuses to go negative', () => {
    it('on a pair that has never been stocked', async () => {
      const res = await adjust({ product_id: product, warehouse_id: warehouse, quantity: -10 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_ENOUGH_STOCK');
      const { inventory, ledger } = await levels();
      expect(inventory).toEqual([]);
      expect(ledger).toEqual([]);
    });

    it('on an existing row, leaving stock and ledger untouched', async () => {
      await adjust({ product_id: product, warehouse_id: warehouse, quantity: 100 });
      const res = await adjust({ product_id: product, warehouse_id: warehouse, quantity: -150 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_ENOUGH_STOCK');
      const { inventory, ledger } = await levels();
      expect(inventory[0].available_qty).toBe(100);
      expect(ledger).toHaveLength(1);
    });
  });

  it('rejects a zero delta, an unknown product and an unknown warehouse', async () => {
    expect((await adjust({ product_id: product, warehouse_id: warehouse, quantity: 0 })).status).toBe(400);
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await adjust({ product_id: missing, warehouse_id: warehouse, quantity: 1 })).status).toBe(404);
    expect((await adjust({ product_id: product, warehouse_id: missing, quantity: 1 })).status).toBe(404);
  });

  it('does not accept an ops role claimed from a buyer organisation', async () => {
    const app2 = app.get(AdjustStockUseCase);
    const uow = app.get(UnitOfWork);
    const { rows } = await withDb((pg) =>
      pg.query(`SELECT id, (SELECT id FROM commerce.organizations WHERE code = 'BUYER-A') AS org
                  FROM commerce.users WHERE email = 'buyer@a.test'`),
    );
    const forged = { userId: rows[0].id, orgId: rows[0].org, orgType: 'buyer' as const, roles: ['ops_admin' as const] };
    await expect(
      uow.withTransaction((tx) =>
        app2.execute(tx, forged, { productId: product, warehouseId: warehouse, quantity: 1, reason: '' }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('is open to ops and ops_admin, closed to buyers', async () => {
    expect((await adjust({ product_id: product, warehouse_id: warehouse, quantity: 1 }, opsAdmin)).status).toBe(200);
    expect((await adjust({ product_id: product, warehouse_id: warehouse, quantity: 1 }, buyer)).status).toBe(403);
    expect((await request(server()).post('/inventories/adjust').send({})).status).toBe(401);
  });
});
