import type { INestApplication } from '@nestjs/common';
import { ReservationExpiryJob } from '../../src/modules/ordering/application/reservation-expiry.job';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { orderAction, postOrder, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

const expireNow = (orderId: string) =>
  withDb((pg) =>
    pg.query(`UPDATE commerce.orders SET reservation_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      orderId,
    ]),
  );

describe('the expiry sweep never touches a paid order', () => {
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

  it('leaves a paid order and its stock untouched even though its hold expired', async () => {
    const buyer = await bearer(server(), 'buyer@a.test');
    const ops = await bearer(server(), 'ops@sf.test');
    const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 4 }] });
    const orderId = created.body.data.id;
    await orderAction(server(), ops, orderId, 'mark-paid');
    await expireNow(orderId);

    await job.run();

    const order = await withDb((pg) => pg.query('SELECT status FROM commerce.orders WHERE id = $1', [orderId]));
    expect(order.rows[0].status).toBe('paid');
    expect(await stockOf(product, warehouse)).toEqual({ available_qty: 6, reserved_qty: 4 });
  });
});
