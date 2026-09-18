import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OrderRepository } from '../../src/modules/ordering/application/ports/order.repository';
import { orgScopeOf } from '../../src/modules/identity/domain/org-scope';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { actorsOf, orderAction, postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

// GET /orders?expires_within_minutes — backs the Reservations screen: soonest-hold-
// ending-first, only for `reserved` orders, still inside the caller's OrgScope.

describe('GET /orders with expires_within_minutes', () => {
  let app: INestApplication;
  let t: Tenants;
  let buyerA: string;
  let buyerB: string;
  let ops: string;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();
  const get = (path: string, auth: string) => request(server()).get(path).set('Authorization', auth);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    [buyerA, buyerB, ops] = await Promise.all([
      bearer(server(), 'buyer@a.test'),
      bearer(server(), 'buyer@b.test'),
      bearer(server(), 'ops@sf.test'),
    ]);
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, 10);
  });

  const setExpiry = (orderId: string, minutesFromNow: number) =>
    withDb((pg) =>
      pg.query('UPDATE commerce.orders SET reservation_expires_at = now() + make_interval(mins => $2) WHERE id = $1', [
        orderId,
        minutesFromNow,
      ]),
    );

  /** Places an order, then backdates its hold so the window can be tested deterministically. */
  const place = async (auth: string, minutesFromNow: number): Promise<{ id: string; order_code: string }> => {
    const body = { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] };
    const res = await postOrder(server(), auth, body);
    const order = res.body.data as { id: string; order_code: string };
    await setExpiry(order.id, minutesFromNow);
    return order;
  };

  it('returns only reserved orders inside the window, soonest (or most overdue) first', async () => {
    const soon = await place(buyerA, 5);
    const overdue = await place(buyerA, -10);
    const later = await place(buyerA, 45);

    const res = await get('/orders?expires_within_minutes=15', buyerA);
    expect(res.status).toBe(200);
    expect(res.body.data.map((o: { id: string }) => o.id)).toEqual([overdue.id, soon.id]);
    expect(res.body.data.map((o: { id: string }) => o.id)).not.toContain(later.id);
  });

  it('implies status=reserved: a paid order never appears, even inside the window', async () => {
    const paid = await place(buyerA, 5);
    const stillReserved = await place(buyerA, 5);
    await orderAction(server(), ops, paid.id, 'mark-paid');

    const res = await get('/orders?expires_within_minutes=60', buyerA);
    const ids = res.body.data.map((o: { id: string }) => o.id);
    expect(ids).not.toContain(paid.id);
    expect(ids).toContain(stillReserved.id);
  });

  it('rejects expires_within_minutes combined with a status other than reserved', async () => {
    const res = await get('/orders?expires_within_minutes=15&status=paid', buyerA);
    expect(res.status).toBe(400);
  });

  it('accepts expires_within_minutes explicitly combined with status=reserved', async () => {
    const soon = await place(buyerA, 5);
    const res = await get('/orders?expires_within_minutes=15&status=reserved', buyerA);
    expect(res.status).toBe(200);
    expect(res.body.data.map((o: { id: string }) => o.id)).toEqual([soon.id]);
  });

  it('keeps OrgScope: a buyer never sees another buyer’s expiring reservations, ops sees both', async () => {
    const mine = await place(buyerA, 5);
    const theirs = await place(buyerB, 5);

    const asA = await get('/orders?expires_within_minutes=60', buyerA);
    const aIds = asA.body.data.map((o: { id: string }) => o.id);
    expect(aIds).toContain(mine.id);
    expect(aIds).not.toContain(theirs.id);

    const asOps = await get('/orders?expires_within_minutes=60', ops);
    const opsIds = asOps.body.data.map((o: { id: string }) => o.id);
    expect(opsIds).toEqual(expect.arrayContaining([mine.id, theirs.id]));
  });

  it('the repository itself never returns a cancelled/fulfilled/expired order for expiresWithinMinutes, even called directly without a status filter', async () => {
    const uow = app.get(UnitOfWork);
    const repo = app.get(OrderRepository);

    const cancelled = await place(buyerA, 5);
    await orderAction(server(), buyerA, cancelled.id, 'cancel');
    // A cancelled order keeps its reservation_expires_at (updateStatus only stamps
    // cancelled_at) — exactly the row that would leak without the repository's own
    // `o.status = 'reserved'` literal.
    const stillReserved = await place(buyerA, 5);

    const rows = await repo.list(uow.db, orgScopeOf(actorsOf(t).ops), { expiresWithinMinutes: 60 }, { page: 1, limit: 50 });
    const ids = rows.map((o) => o.id);
    expect(ids).not.toContain(cancelled.id);
    expect(ids).toContain(stillReserved.id);
  });
});
