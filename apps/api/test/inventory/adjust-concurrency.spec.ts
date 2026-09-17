import type { INestApplication } from '@nestjs/common';
import { AdjustStockUseCase } from '../../src/modules/inventory/application/use-cases/adjust-stock.use-case';
import type { Actor } from '../../src/modules/identity/domain/actor';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * StockFlow read the row `FOR UPDATE` and created it when the read found nothing.
 * `FOR UPDATE` locks no row when there is none, so two first-ever adjustments for
 * the same pair raced: one lost its ledger row or failed on the unique index.
 */
describe('concurrent adjustments to a pair that has never been stocked', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let adjustStock: AdjustStockUseCase;
  let t: Tenants;
  let product: string;
  let warehouse: string;

  const ops = (): Actor => ({ userId: t.users.ops, orgId: t.internal, orgType: 'internal', roles: ['ops'] });

  beforeAll(async () => {
    app = await createTestApp();
    uow = app.get(UnitOfWork);
    adjustStock = app.get(AdjustStockUseCase);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
  });

  it('ends with one row, the full quantity and one ledger row per adjustment', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        uow.withTransaction((tx) =>
          adjustStock.execute(tx, ops(), { productId: product, warehouseId: warehouse, quantity: 10, reason: '' }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const { inventory, ledger } = await withDb(async (pg) => ({
      inventory: (await pg.query('SELECT * FROM commerce.inventory')).rows,
      ledger: (await pg.query('SELECT * FROM commerce.inventory_transactions')).rows,
    }));
    expect(inventory).toHaveLength(1);
    expect(inventory[0].available_qty).toBe(100);
    expect(inventory[0].version).toBe(10);
    expect(ledger).toHaveLength(10);
    // Each ledger row describes a real step, and together they add up to the total.
    expect(ledger.every((r) => r.after_available_qty - r.before_available_qty === 10)).toBe(true);
    expect(new Set(ledger.map((r) => r.after_available_qty)).size).toBe(10);
  });
});
