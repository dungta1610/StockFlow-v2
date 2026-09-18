import type { INestApplication } from '@nestjs/common';
import { AdjustStockUseCase } from '../../src/modules/inventory/application/use-cases/adjust-stock.use-case';
import { CreateOrderUseCase } from '../../src/modules/ordering/application/use-cases/create-order.use-case';
import {
  CancelOrderUseCase,
  ExpireOrderUseCase,
  FulfillOrderUseCase,
  MarkOrderPaidUseCase,
} from '../../src/modules/ordering/application/use-cases/order-transition.use-cases';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { actorsOf, prng, stockInvariantViolations, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * Random batches of every write path, run concurrently. Whatever wins each race,
 * available + reserved must equal what was adjusted in minus what shipped, the ledger
 * must add up to the current levels, and every reservation must agree with its order.
 */
describe('stock invariants under a random mix of order operations', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let t: Tenants;
  let warehouse: string;
  let products: string[];

  beforeAll(async () => {
    app = await createTestApp();
    uow = app.get(UnitOfWork);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    await withDb(async (pg) => {
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
      products = [
        await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' }),
        await insertProduct(pg, { sku: 'SKU-2', basePrice: '1000' }),
        await insertProduct(pg, { sku: 'SKU-3', basePrice: '1000' }),
      ];
    });
    // Little stock on purpose: many orders must fail for lack of it.
    for (const p of products) await stockUp(app, t, p, warehouse, 25);
  });

  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: the books balance after every round`, async () => {
      const random = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
      const { ops, buyerA, buyerB } = actorsOf(t);
      const create = app.get(CreateOrderUseCase);
      const transitions = {
        cancel: app.get(CancelOrderUseCase),
        expire: app.get(ExpireOrderUseCase),
        markPaid: app.get(MarkOrderPaidUseCase),
        fulfill: app.get(FulfillOrderUseCase),
      };
      const adjust = app.get(AdjustStockUseCase);
      const orderIds: string[] = [];

      const operation = (): (() => Promise<unknown>) => {
        const roll = random();
        if (roll < 0.4 || orderIds.length === 0) {
          const buyer = pick([buyerA, buyerB]);
          const items = [...products]
            .sort(() => random() - 0.5)
            .slice(0, 1 + Math.floor(random() * 3))
            .map((productId) => ({ productId, quantity: 1 + Math.floor(random() * 5) }));
          return () =>
            uow
              .withTransaction((tx) => create.execute(tx, buyer, { warehouseId: warehouse, items }, new Date()))
              .then((o) => orderIds.push(o.id));
        }
        if (roll < 0.85) {
          const action = pick(['cancel', 'expire', 'markPaid', 'fulfill'] as const);
          const orderId = pick(orderIds);
          return () => uow.withTransaction((tx) => transitions[action].execute(tx, ops, { orderId }));
        }
        const delta = random() < 0.5 ? 1 + Math.floor(random() * 10) : -(1 + Math.floor(random() * 5));
        return () =>
          uow.withTransaction((tx) =>
            adjust.execute(tx, ops, { productId: pick(products), warehouseId: warehouse, quantity: delta, reason: '' }),
          );
      };

      for (let round = 0; round < 8; round++) {
        const batch = Array.from({ length: 12 }, operation);
        const results = await Promise.allSettled(batch.map((job) => job()));
        // Business refusals are expected; anything else (a 500, a deadlock) is a bug.
        const unexpected = results.filter(
          (r) => r.status === 'rejected' && !(r.reason as { status?: number }).status,
        );
        expect(unexpected).toEqual([]);
        expect(await stockInvariantViolations()).toEqual([]);
      }
    });
  }
});
