import type { INestApplication } from '@nestjs/common';
import type { Actor } from '../../src/modules/identity/domain/actor';
import { InventoryService } from '../../src/modules/inventory/application/inventory.service';
import { AdjustStockUseCase } from '../../src/modules/inventory/application/use-cases/adjust-stock.use-case';
import { LedgerService } from '../../src/modules/inventory/application/ledger.service';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

// The surface the copilot (phase 08) calls. It takes codes, not uuids, because that
// is what a person — or a model reading a chat — actually has.
describe('InventoryService.getStatus / LedgerService.history', () => {
  let app: INestApplication;
  let inventory: InventoryService;
  let ledger: LedgerService;
  let adjustStock: AdjustStockUseCase;
  let uow: UnitOfWork;
  let product: string;
  let hanoi: string;
  let t: Tenants;

  const ops = (): Actor => ({ userId: t.users.ops, orgId: t.internal, orgType: 'internal', roles: ['ops'] });
  const buyer = (): Actor => ({ userId: t.users.buyerA, orgId: t.buyerA, orgType: 'buyer', roles: ['buyer'] });

  beforeAll(async () => {
    app = await createTestApp();
    inventory = app.get(InventoryService);
    ledger = app.get(LedgerService);
    adjustStock = app.get(AdjustStockUseCase);
    uow = app.get(UnitOfWork);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'ABC-1', basePrice: '1000' });
      hanoi = await insertWarehouse(pg, { code: 'HN-01' });
      const saigon = await insertWarehouse(pg, { code: 'HCM-01' });
      await insertProduct(pg, { sku: 'NO-STOCK', basePrice: '1000' });
      await pg.query(
        `INSERT INTO commerce.inventory (product_id, warehouse_id, available_qty, reserved_qty)
         VALUES ($1, $2, 12, 3), ($1, $3, 7, 0)`,
        [product, hanoi, saigon],
      );
    });
  });

  it('finds stock by SKU in any letter case, across every warehouse', async () => {
    const status = await inventory.getStatus(uow.db, ops(), { sku: ' abc-1 ' });
    expect(status.sku).toBe('ABC-1');
    expect(status.total).toEqual({ available: 19, reserved: 3 });
    expect(status.warehouses).toEqual([
      { warehouseCode: 'HCM-01', warehouseName: 'HCM-01', available: 7, reserved: 0 },
      { warehouseCode: 'HN-01', warehouseName: 'HN-01', available: 12, reserved: 3 },
    ]);
  });

  it('narrows to one warehouse by code', async () => {
    const status = await inventory.getStatus(uow.db, ops(), { sku: 'ABC-1', warehouseCode: 'hn-01' });
    expect(status.warehouses.map((w) => w.warehouseCode)).toEqual(['HN-01']);
    expect(status.total).toEqual({ available: 12, reserved: 3 });
  });

  it('says plainly when a code does not exist, instead of returning nothing', async () => {
    await expect(inventory.getStatus(uow.db, ops(), { sku: 'NOPE' })).rejects.toMatchObject({
      code: 'PRODUCT_NOT_FOUND',
      status: 404,
    });
    await expect(
      inventory.getStatus(uow.db, ops(), { sku: 'ABC-1', warehouseCode: 'NOPE' }),
    ).rejects.toMatchObject({ code: 'WAREHOUSE_NOT_FOUND', status: 404 });
  });

  it('reports a stocked product with no rows as zero, not as an error', async () => {
    const status = await inventory.getStatus(uow.db, ops(), { sku: 'NO-STOCK' });
    expect(status.total).toEqual({ available: 0, reserved: 0 });
    expect(status.warehouses).toEqual([]);
  });

  it('returns the ledger for a SKU, newest first', async () => {
    for (const quantity of [5, -2]) {
      await uow.withTransaction((tx) =>
        adjustStock.execute(tx, ops(), { productId: product, warehouseId: hanoi, quantity, reason: 'kiểm kê' }),
      );
    }
    const history = await ledger.history(uow.db, ops(), { sku: 'abc-1' }, { page: 1, limit: 10 });
    expect(history.map((h) => [h.quantity, h.beforeAvailableQty, h.afterAvailableQty])).toEqual([
      [2, 17, 15],
      [5, 12, 17],
    ]);
    expect(history[0]!.txnType).toBe('manual_adjustment');
  });

  it('is closed to buyers', async () => {
    await expect(inventory.getStatus(uow.db, buyer(), { sku: 'ABC-1' })).rejects.toMatchObject({ status: 403 });
    await expect(
      ledger.history(uow.db, buyer(), { sku: 'ABC-1' }, { page: 1, limit: 10 }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
