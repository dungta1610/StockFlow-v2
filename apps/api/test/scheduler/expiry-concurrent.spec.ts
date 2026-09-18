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
import { postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

const ORDER_COUNT = 50;

describe('two sweeps racing the same expired orders', () => {
  let app: INestApplication;
  let t: Tenants;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    t = await seedTenants();
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, ORDER_COUNT);
  });

  it('releases each of 50 expired orders exactly once — stock is never double-released', async () => {
    const buyer = await bearer(server(), 'buyer@a.test');
    for (let i = 0; i < ORDER_COUNT; i++) {
      const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] });
      expect(created.status).toBe(201);
    }
    await withDb((pg) =>
      pg.query(`UPDATE commerce.orders SET reservation_expires_at = now() - interval '1 minute' WHERE status = 'reserved'`),
    );
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 0, reserved_qty: ORDER_COUNT });

    const newJob = () =>
      new ReservationExpiryJob(
        app.get(SchedulerRunner),
        app.get(UnitOfWork),
        app.get(OrderRepository),
        app.get(ExpireOrderUseCase),
        configWithOverrides(app.get(ConfigService), { RESERVATION_SWEEP_BATCH: ORDER_COUNT }),
      );

    await Promise.all([newJob().run(), newJob().run()]);

    expect(await stockOf(product, warehouse)).toEqual({ available_qty: ORDER_COUNT, reserved_qty: 0 });
    const expired = await withDb((pg) => pg.query(`SELECT count(*) AS n FROM commerce.orders WHERE status = 'expired'`));
    expect(Number(expired.rows[0].n)).toBe(ORDER_COUNT);
    const releases = await withDb((pg) =>
      pg.query(`SELECT count(*) AS n FROM commerce.inventory_transactions WHERE txn_type = 'release'`),
    );
    expect(Number(releases.rows[0].n)).toBe(ORDER_COUNT);
  });
});
