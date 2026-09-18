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

const expireNow = (orderId: string) =>
  withDb((pg) =>
    pg.query(`UPDATE commerce.orders SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      orderId,
    ]),
  );

/**
 * RESERVATION_SWEEP_BATCH limits how many ORDERS one run touches, never how many
 * lines of one order. Three expired three-line orders with a batch of 2 must leave
 * exactly one order completely untouched (all three of its lines still held) and
 * fully release the other two (all three of each of their lines) — proof the limit
 * lands on an order boundary, never inside one.
 */
describe('a sweep batch limits orders, never lines within an order', () => {
  let app: INestApplication;
  let t: Tenants;
  let job: ReservationExpiryJob;
  let products: string[];
  let warehouse: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
    job = new ReservationExpiryJob(
      app.get(SchedulerRunner),
      app.get(UnitOfWork),
      app.get(OrderRepository),
      app.get(ExpireOrderUseCase),
      configWithOverrides(app.get(ConfigService), { RESERVATION_SWEEP_BATCH: 2 }),
    );
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
    for (const p of products) await stockUp(app, t, p, warehouse, 30);
  });

  it('releases all three lines of two orders, leaves a third order and its lines untouched', async () => {
    const buyer = await bearer(server(), 'buyer@a.test');
    const items = products.map((p, i) => ({ product_id: p, quantity: i + 1 }));
    const orderIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items });
      expect(created.status).toBe(201);
      orderIds.push(created.body.data.id);
      await expireNow(created.body.data.id);
    }

    await job.run();

    const statuses = await withDb((pg) =>
      pg.query('SELECT id, status FROM commerce.orders WHERE id = ANY($1::uuid[]) ORDER BY id', [orderIds]),
    );
    const untouched = statuses.rows.filter((r) => r.status === 'reserved');
    const expired = statuses.rows.filter((r) => r.status === 'expired');
    expect(expired).toHaveLength(2);
    expect(untouched).toHaveLength(1);

    for (const row of expired) {
      const reservations = await withDb((pg) =>
        pg.query('SELECT status FROM commerce.inventory_reservations WHERE order_id = $1', [row.id]),
      );
      expect(reservations.rows).toHaveLength(3);
      expect(reservations.rows.every((r) => r.status === 'released')).toBe(true);
    }
    for (const row of untouched) {
      const reservations = await withDb((pg) =>
        pg.query('SELECT status FROM commerce.inventory_reservations WHERE order_id = $1', [row.id]),
      );
      expect(reservations.rows).toHaveLength(3);
      expect(reservations.rows.every((r) => r.status === 'held')).toBe(true);
    }

    // Stock reflects exactly the two released orders: one order's worth (1+2+3 per
    // product) remains reserved, from the untouched third order.
    for (const p of products) {
      const level = await stockOf(p, warehouse);
      expect(level.available_qty + level.reserved_qty).toBe(30);
      expect(level.reserved_qty).toBeGreaterThan(0);
    }
  });
});
