import type { INestApplication } from '@nestjs/common';
import { AdjustStockUseCase } from '../../src/modules/inventory/application/use-cases/adjust-stock.use-case';
import { CreateOrderUseCase } from '../../src/modules/ordering/application/use-cases/create-order.use-case';
import {
  CancelOrderUseCase,
  ExpireOrderUseCase,
} from '../../src/modules/ordering/application/use-cases/order-transition.use-cases';
import type { OrderWithItems } from '../../src/modules/ordering/domain/order';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import {
  LOCK_FAILURES,
  actorsOf,
  pgCodeOf,
  prng,
  stockInvariantViolations,
  stockUp,
} from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * Four write paths touch the same rows: creating an order, cancelling one, adjusting
 * stock and the expiry sweep. They share one lock order — orders, then that order's
 * reservations, then stock rows by product id — so running them all at once on the
 * same products must never deadlock or time out waiting for a lock.
 */
describe('create, cancel, adjust and the expiry sweep at the same time', () => {
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
    for (const p of products) await stockUp(app, t, p, warehouse, 500);
  });

  it('finishes every flow without a deadlock or lock timeout, and the books balance', async () => {
    const random = prng(4);
    const { ops, buyerA } = actorsOf(t);
    const create = app.get(CreateOrderUseCase);
    const cancel = app.get(CancelOrderUseCase);
    const expire = app.get(ExpireOrderUseCase);
    const adjust = app.get(AdjustStockUseCase);

    /** 2–3 products in a random order, 1–3 units each. */
    const randomItems = () =>
      [...products]
        .sort(() => random() - 0.5)
        .slice(0, 2 + Math.floor(random() * 2))
        .map((productId) => ({ productId, quantity: 1 + Math.floor(random() * 3) }));
    const placeOrder = (now: Date) =>
      uow.withTransaction((tx) => create.execute(tx, buyerA, { warehouseId: warehouse, items: randomItems() }, now));

    // Orders whose hold ended an hour ago (the sweep's work) and live ones (to cancel).
    const longAgo = new Date(Date.now() - 2 * 3600_000);
    const overdue: OrderWithItems[] = [];
    const live: OrderWithItems[] = [];
    for (let i = 0; i < 12; i++) overdue.push(await placeOrder(longAgo));
    for (let i = 0; i < 12; i++) live.push(await placeOrder(new Date()));

    // Like the real sweep: one transaction per order, and one order's failure does
    // not stop the others.
    const sweepFailures: unknown[] = [];
    const sweep = async () => {
      const ids = await withDb(async (pg) =>
        (
          await pg.query<{ id: string }>(
            `SELECT id FROM commerce.orders
              WHERE status = 'reserved' AND reservation_expires_at < now() ORDER BY id`,
          )
        ).rows.map((r) => r.id),
      );
      for (const id of ids) {
        await uow.withTransaction((tx) => expire.execute(tx, ops, { orderId: id })).catch((e) => sweepFailures.push(e));
      }
    };

    const jobs: (() => Promise<unknown>)[] = [
      ...Array.from({ length: 20 }, () => () => placeOrder(new Date())),
      ...live.map((o) => () => uow.withTransaction((tx) => cancel.execute(tx, buyerA, { orderId: o.id }))),
      // Some overdue orders are cancelled while the sweep expires them: whichever
      // comes second finds the order already closed.
      ...overdue.slice(0, 4).map((o) => () => uow.withTransaction((tx) => cancel.execute(tx, ops, { orderId: o.id }))),
      ...Array.from({ length: 12 }, (_, i) => () =>
        uow.withTransaction((tx) =>
          adjust.execute(tx, ops, {
            productId: products[i % 3]!,
            warehouseId: warehouse,
            quantity: i % 2 === 0 ? 7 : -3,
            reason: 'recount',
          }),
        ),
      ),
      sweep,
      sweep,
    ];
    const results = await Promise.allSettled(jobs.sort(() => random() - 0.5).map((job) => job()));

    const failures = [...results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : [])), ...sweepFailures];
    expect(failures.filter((e) => LOCK_FAILURES.includes(pgCodeOf(e) ?? ''))).toEqual([]);
    // Whichever of cancel and expire reaches an overdue order second finds it closed
    // and returns it unchanged, so nothing at all may fail.
    expect(failures).toEqual([]);

    const statuses = await withDb(async (pg) =>
      (await pg.query<{ status: string }>('SELECT status FROM commerce.orders WHERE id = ANY($1::uuid[])', [
        overdue.map((o) => o.id),
      ])).rows.map((r) => r.status),
    );
    expect(statuses.every((s) => s === 'expired' || s === 'cancelled')).toBe(true);
    expect(await stockInvariantViolations()).toEqual([]);
  });
});
