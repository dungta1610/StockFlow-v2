import type { INestApplication } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { PriceResolver } from '../../src/modules/pricing/application/ports/price-resolver';
import type { Tx } from '../../src/platform/database/tx';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertPriceList, insertProduct, insertTier } from '../helpers/catalog-fixtures';
import { seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

const NOW = new Date('2026-06-01T00:00:00Z');

/** Wraps a Tx and counts the statements that go through it. */
const counting = (tx: Tx) => {
  let n = 0;
  return {
    get count() {
      return n;
    },
    tx: {
      query: <T extends QueryResultRow>(sql: string, params?: unknown[]) => {
        n++;
        return tx.query<T>(sql, params);
      },
    } satisfies Tx,
  };
};

describe('PriceResolver (Postgres)', () => {
  let app: INestApplication;
  let resolver: PriceResolver;
  let uow: UnitOfWork;
  let t: Tenants;
  let products: string[];
  let contractA: string;

  const buyerA = () => ({ id: t.buyerA, type: 'buyer' as const });
  const scopeA = () => ({ kind: 'single' as const, orgId: t.buyerA });

  beforeAll(async () => {
    app = await createTestApp();
    resolver = app.get(PriceResolver);
    uow = app.get(UnitOfWork);
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    t = await seedTenants();
    await withDb(async (pg) => {
      products = [];
      for (let i = 1; i <= 20; i++) {
        products.push(await insertProduct(pg, { sku: `SKU-${i}`, basePrice: '60000' }));
      }
      const defaults = await insertPriceList(pg, { name: 'default' });
      contractA = await insertPriceList(pg, { orgId: t.buyerA, name: 'contract A' });
      const contractB = await insertPriceList(pg, { orgId: t.buyerB, name: 'contract B', priority: 99 });
      // SKU-1: default + contract A tiers; SKU-2: default only; SKU-3: nothing.
      await insertTier(pg, { listId: defaults, productId: products[0]!, unitPrice: '50000' });
      await insertTier(pg, { listId: defaults, productId: products[1]!, unitPrice: '52000' });
      await insertTier(pg, { listId: contractA, productId: products[0]!, unitPrice: '45000' });
      await insertTier(pg, { listId: contractA, productId: products[0]!, minQty: 100, unitPrice: '40000' });
      await insertTier(pg, { listId: contractB, productId: products[0]!, unitPrice: '1000' });
      await insertTier(pg, { listId: contractB, productId: products[1]!, unitPrice: '1000' });
    });
  });

  it('reports where each price came from', async () => {
    const lines = await resolver.resolve(uow.db, scopeA(), buyerA(), [
      { productId: products[0]!, qty: 1 },
      { productId: products[1]!, qty: 1 },
      { productId: products[2]!, qty: 1 },
    ], NOW);

    expect(lines.map((l) => [l.sku, l.sourceKind, l.unitPrice.toString()])).toEqual([
      ['SKU-1', 'contract', '45000.00'],
      ['SKU-2', 'default_list', '52000.00'],
      ['SKU-3', 'base_price', '60000.00'],
    ]);
    expect(lines[2]!.sourceId).toBeNull();
    expect(lines[0]!.priceListId).toBe(contractA);
  });

  it('applies quantity tiers and computes the line total exactly', async () => {
    const [line] = await resolver.resolve(uow.db, scopeA(), buyerA(), [{ productId: products[0]!, qty: 150 }], NOW);
    expect(line).toMatchObject({ qty: 150, minQtyApplied: 100 });
    expect(line!.unitPrice.toString()).toBe('40000.00');
    expect(line!.lineTotal.toString()).toBe('6000000.00');
  });

  it('never uses another customer’s contract, whatever its priority', async () => {
    const lines = await resolver.resolve(uow.db, scopeA(), buyerA(), [
      { productId: products[0]!, qty: 1 },
      { productId: products[1]!, qty: 1 },
    ], NOW);
    expect(lines.every((l) => l.unitPrice.toString() !== '1000.00')).toBe(true);
  });

  it('uses the same small number of queries for 1 line and for 20', async () => {
    const one = counting(uow.db);
    await resolver.resolve(one.tx, scopeA(), buyerA(), [{ productId: products[0]!, qty: 1 }], NOW);

    const twenty = counting(uow.db);
    await resolver.resolve(twenty.tx, scopeA(), buyerA(), products.map((productId) => ({ productId, qty: 3 })), NOW);

    expect(one.count).toBeLessThanOrEqual(2);
    expect(twenty.count).toBe(one.count);
  });

  it('keeps lines in request order', async () => {
    const order = [products[4]!, products[0]!, products[9]!];
    const lines = await resolver.resolve(uow.db, scopeA(), buyerA(), order.map((productId) => ({ productId, qty: 1 })), NOW);
    expect(lines.map((l) => l.productId)).toEqual(order);
  });

  describe('scope', () => {
    it('a buyer cannot price for another organisation', async () => {
      await expect(
        resolver.resolve(uow.db, scopeA(), { id: t.buyerB, type: 'buyer' }, [{ productId: products[0]!, qty: 1 }], NOW),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('ops can price for any buyer', async () => {
      const [line] = await resolver.resolve(
        uow.db,
        { kind: 'all-buyers' },
        { id: t.buyerB, type: 'buyer' },
        [{ productId: products[0]!, qty: 1 }],
        NOW,
      );
      expect(line!.unitPrice.toString()).toBe('1000.00');
    });

    it('nobody gets contract prices for the internal organisation', async () => {
      await expect(
        resolver.resolve(uow.db, { kind: 'all-buyers' }, { id: t.internal, type: 'internal' }, [{ productId: products[0]!, qty: 1 }], NOW),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('invalid lines', () => {
    it('rejects an unknown product', async () => {
      await expect(
        resolver.resolve(uow.db, scopeA(), buyerA(), [{ productId: '00000000-0000-4000-8000-000000000000', qty: 1 }], NOW),
      ).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', status: 404 });
    });

    it('rejects an inactive product', async () => {
      await withDb((pg) => pg.query('UPDATE commerce.products SET is_active = false WHERE id = $1', [products[0]]));
      await expect(
        resolver.resolve(uow.db, scopeA(), buyerA(), [{ productId: products[0]!, qty: 1 }], NOW),
      ).rejects.toMatchObject({ code: 'PRODUCT_INACTIVE' });
    });

    it('rejects a non-positive quantity', async () => {
      await expect(
        resolver.resolve(uow.db, scopeA(), buyerA(), [{ productId: products[0]!, qty: 0 }], NOW),
      ).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
    });
  });
});
