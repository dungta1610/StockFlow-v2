import type { INestApplication } from '@nestjs/common';
import { ReservationExpiryJob } from '../../src/modules/ordering/application/reservation-expiry.job';
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

describe('the expiry sweep releases stock held by an overdue order', () => {
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

  it('expires the order, releases the reservation and restores the ledger levels', async () => {
    const buyer = await bearer(server(), 'buyer@a.test');
    const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 4 }] });
    expect(created.status).toBe(201);
    const orderId = created.body.data.id;
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 6, reserved_qty: 4 });

    await expireNow(orderId);
    await job.run();

    const order = await withDb((pg) => pg.query('SELECT status FROM commerce.orders WHERE id = $1', [orderId]));
    expect(order.rows[0].status).toBe('expired');
    const reservation = await withDb((pg) =>
      pg.query('SELECT status FROM commerce.inventory_reservations WHERE order_id = $1', [orderId]),
    );
    expect(reservation.rows.map((r) => r.status)).toEqual(['released']);
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 10, reserved_qty: 0 });

    const releaseLedger = await withDb((pg) =>
      pg.query(`SELECT count(*) AS n FROM commerce.inventory_transactions WHERE txn_type = 'release' AND order_id = $1`, [
        orderId,
      ]),
    );
    expect(Number(releaseLedger.rows[0].n)).toBe(1);
  });
});
