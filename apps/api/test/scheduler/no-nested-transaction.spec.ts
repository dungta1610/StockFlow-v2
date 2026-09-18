import { Logger, type INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { ReservationExpiryJob } from '../../src/modules/ordering/application/reservation-expiry.job';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

const expireNow = (orderId: string) =>
  withDb((pg) =>
    pg.query(`UPDATE commerce.orders SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      orderId,
    ]),
  );

/**
 * The sweep never opens a transaction inside another one (docs/adr/0004, 0018): if
 * some other connection already holds the order's row lock, the sweep's own
 * `FOR UPDATE` waits behind it like any other lock contention, bounded by
 * `lock_timeout` (5s). It must never hang past that, and the rest of the batch —
 * here, none — is unaffected.
 */
describe('the sweep never hangs behind a lock it does not control', () => {
  let app: INestApplication;
  let t: Tenants;
  let job: ReservationExpiryJob;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
    job = app.get(ReservationExpiryJob);
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

  it('times out at lock_timeout, logs the failure, and leaves the order untouched', async () => {
    const buyer = await bearer(server(), 'buyer@a.test');
    const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 2 }] });
    const orderId = created.body.data.id;
    await expireNow(orderId);

    const errorSpy = vi.spyOn(Logger.prototype, 'error');

    // Hold the order's row lock from a second connection, open-ended (no COMMIT),
    // exactly the contention a completely unrelated in-flight transaction would create.
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT * FROM commerce.orders WHERE id = $1 FOR UPDATE', [orderId]);
    try {
      const start = Date.now();
      await expect(
        Promise.race([
          job.run(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('job.run() hung past 8s')), 8_000)),
        ]),
      ).resolves.toBeUndefined();
      const elapsed = Date.now() - start;

      // lock_timeout is 5s; leave slack for CI, but this must not have returned
      // instantly (it genuinely waited on the lock) nor hung indefinitely.
      expect(elapsed).toBeGreaterThan(3_000);
      expect(elapsed).toBeLessThan(8_000);

      const order = await withDb((pg) => pg.query('SELECT status FROM commerce.orders WHERE id = $1', [orderId]));
      expect(order.rows[0].status).toBe('reserved');
      const logged = errorSpy.mock.calls.some((c) => String(c[0]).includes(orderId));
      expect(logged).toBe(true);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
      errorSpy.mockRestore();
    }
  });
});
