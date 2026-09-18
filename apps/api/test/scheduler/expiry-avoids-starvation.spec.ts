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

const expireAt = (orderId: string, secondsAgo: number) =>
  withDb((pg) =>
    pg.query(`UPDATE commerce.orders SET reservation_expires_at = now() - ($2 || ' seconds')::interval WHERE id = $1`, [
      orderId,
      secondsAgo,
    ]),
  );

const statusOf = (orderId: string) =>
  withDb(async (pg) => (await pg.query('SELECT status FROM commerce.orders WHERE id = $1', [orderId])).rows[0].status);

/**
 * If the same persistently failing orders were re-selected every run
 * (`ORDER BY id LIMIT batch` with no memory of what already failed), an order
 * behind them in the queue would never get its turn. The job keeps a cursor that
 * advances past whatever it touched — pass or fail — so later orders make
 * progress across repeated sweeps even while earlier ones keep failing.
 */
describe('the expiry sweep does not starve behind persistently failing orders', () => {
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
    await stockUp(app, t, product, warehouse, 30);
  });

  it('a healthy order behind two always-failing ones expires on a later sweep instead of never', async () => {
    const buyer = await bearer(server(), 'buyer@a.test');
    const orderIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] });
      expect(created.status).toBe(201);
      orderIds.push(created.body.data.id);
    }
    const [failingA, failingB, healthy] = orderIds;
    // Soonest-first order: the two failing orders expire earliest, so an
    // unfixed sweep would always select them first.
    await expireAt(failingA!, 30);
    await expireAt(failingB!, 20);
    await expireAt(healthy!, 10);

    const failingIds = new Set([failingA, failingB]);
    const realExpireOrder = app.get(ExpireOrderUseCase);
    const flakyExpireOrder = {
      execute: (tx: Parameters<ExpireOrderUseCase['execute']>[0], actor: Parameters<ExpireOrderUseCase['execute']>[1], input: Parameters<ExpireOrderUseCase['execute']>[2]) => {
        if (failingIds.has(input.orderId)) throw new Error('synthetic persistent failure');
        return realExpireOrder.execute(tx, actor, input);
      },
    } as ExpireOrderUseCase;

    const job = new ReservationExpiryJob(
      app.get(SchedulerRunner),
      app.get(UnitOfWork),
      app.get(OrderRepository),
      flakyExpireOrder,
      configWithOverrides(app.get(ConfigService), { RESERVATION_SWEEP_BATCH: 2 }),
    );

    // Run 1: batch of 2 selects [failingA, failingB] (soonest first) — both fail.
    await job.run();
    expect(await statusOf(failingA!)).toBe('reserved');
    expect(await statusOf(failingB!)).toBe('reserved');
    expect(await statusOf(healthy!)).toBe('reserved'); // not reached yet

    // Run 2: the cursor resumes past failingB, so this run reaches `healthy`.
    await job.run();
    expect(await statusOf(healthy!)).toBe('expired');
  });
});
