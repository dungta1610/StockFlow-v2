import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderRepository } from '../../src/modules/ordering/application/ports/order.repository';
import { ReservationExpiryJob } from '../../src/modules/ordering/application/reservation-expiry.job';
import { ExpireOrderUseCase } from '../../src/modules/ordering/application/use-cases/order-transition.use-cases';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { SchedulerRunner } from '../../src/platform/scheduler/scheduler.runner';
import { configWithOverrides } from '../helpers/config-fixtures';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

const setExpiresAt = (orderId: string, exact: string) =>
  withDb((pg) =>
    pg.query(`UPDATE commerce.orders SET reservation_expires_at = $2::timestamptz WHERE id = $1`, [orderId, exact]),
  );

const statusOf = (orderId: string) =>
  withDb(async (pg) => (await pg.query('SELECT status FROM commerce.orders WHERE id = $1', [orderId])).rows[0].status);

/**
 * Postgres stores `reservation_expires_at` to the microsecond; a cursor carried as
 * a JS `Date` only holds milliseconds. If the cursor is built from a row whose
 * real value has sub-millisecond digits, the truncated cursor sorts *before* that
 * row's own real value, so `(reservation_expires_at, id) > cursor` keeps matching
 * it (and anything else sharing its millisecond) forever — the same starvation
 * the cursor exists to prevent, reopened at microsecond granularity.
 */
describe('the expiry sweep cursor keeps microsecond precision', () => {
  let app: INestApplication;
  let t: Tenants;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, 10);
  });

  it('a later order still expires behind a full batch of always-failing orders sharing one millisecond', async () => {
    const buyer = await bearer(server(), 'buyer@a.test');
    const orderIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] });
      expect(created.status).toBe(201);
      orderIds.push(created.body.data.id);
    }
    const [failingA, failingB, failingC, healthy] = orderIds;
    // Three orders share one millisecond and differ only in microseconds; the
    // healthy order is later but still expired.
    await setExpiresAt(failingA!, '2020-01-01T00:00:00.123001Z');
    await setExpiresAt(failingB!, '2020-01-01T00:00:00.123002Z');
    await setExpiresAt(failingC!, '2020-01-01T00:00:00.123003Z');
    await setExpiresAt(healthy!, '2020-01-01T00:00:00.200000Z');

    const failingIds = new Set([failingA, failingB, failingC]);
    const realExpireOrder = app.get(ExpireOrderUseCase);
    const flakyExpireOrder = {
      execute: (
        tx: Parameters<ExpireOrderUseCase['execute']>[0],
        actor: Parameters<ExpireOrderUseCase['execute']>[1],
        input: Parameters<ExpireOrderUseCase['execute']>[2],
      ) => {
        if (failingIds.has(input.orderId)) throw new Error('synthetic persistent failure');
        return realExpireOrder.execute(tx, actor, input);
      },
    } as ExpireOrderUseCase;

    // A batch size equal to the failing set makes the first page exactly a full
    // batch, so the cursor never resets between runs — the precondition for a
    // millisecond-truncated cursor to keep re-selecting the same page.
    const job = new ReservationExpiryJob(
      app.get(SchedulerRunner),
      app.get(UnitOfWork),
      app.get(OrderRepository),
      flakyExpireOrder,
      configWithOverrides(app.get(ConfigService), { RESERVATION_SWEEP_BATCH: 3 }),
    );

    // Run 1: claims the 3 failing orders (soonest microsecond first); all fail.
    await job.run();
    expect(await statusOf(failingA!)).toBe('reserved');
    expect(await statusOf(failingB!)).toBe('reserved');
    expect(await statusOf(failingC!)).toBe('reserved');
    expect(await statusOf(healthy!)).toBe('reserved');

    // Run 2: a precise cursor excludes all three failing orders (their real
    // value never exceeds the exact cursor) and reaches `healthy` instead.
    await job.run();
    expect(await statusOf(healthy!)).toBe('expired');
  });
});
