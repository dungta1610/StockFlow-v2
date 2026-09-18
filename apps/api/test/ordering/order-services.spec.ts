import type { INestApplication } from '@nestjs/common';
import type { Actor } from '../../src/modules/identity/domain/actor';
import { orgScopeOf } from '../../src/modules/identity/domain/org-scope';
import { OrderService } from '../../src/modules/ordering/application/order.service';
import { ReservationService } from '../../src/modules/ordering/application/reservation.service';
import { CreateOrderUseCase } from '../../src/modules/ordering/application/use-cases/create-order.use-case';
import { CancelOrderUseCase } from '../../src/modules/ordering/application/use-cases/order-transition.use-cases';
import { diagnoseOrder } from '../../src/modules/ordering/domain/diagnose-order';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { actorsOf, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

// The read surface the copilot will call. Every method takes an OrgScope first.

describe('diagnoseOrder (pure)', () => {
  const now = new Date('2026-09-18T10:00:00Z');
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  it('a reserved order waits for payment and warns when the hold is about to end', () => {
    expect(diagnoseOrder({ status: 'reserved', reservationExpiresAt: at(20) }, [], now)).toEqual({
      nextStatuses: ['paid', 'cancelled', 'expired'],
      blockers: [{ kind: 'awaiting_payment' }, { kind: 'reservation_expiring', expiresAt: at(20), minutesLeft: 20 }],
    });
    expect(diagnoseOrder({ status: 'reserved', reservationExpiresAt: at(120) }, [], now).blockers).toEqual([
      { kind: 'awaiting_payment' },
    ]);
    expect(diagnoseOrder({ status: 'reserved', reservationExpiresAt: at(-5) }, [], now).blockers).toEqual([
      { kind: 'awaiting_payment' },
      { kind: 'reservation_overdue', expiresAt: at(-5) },
    ]);
  });

  it('a paid order waits for fulfilment', () => {
    expect(diagnoseOrder({ status: 'paid', reservationExpiresAt: null }, [], now)).toEqual({
      nextStatuses: ['fulfilled'],
      blockers: [{ kind: 'awaiting_fulfilment' }],
    });
  });

  it('a closed order names the lines that could not be placed again today', () => {
    const lines = [
      { productId: 'p1', sku: 'SKU-1', quantity: 5, available: 2 },
      { productId: 'p2', sku: 'SKU-2', quantity: 1, available: 9 },
    ];
    expect(diagnoseOrder({ status: 'expired', reservationExpiresAt: at(-60) }, lines, now).blockers).toEqual([
      { kind: 'closed', status: 'expired' },
      { kind: 'insufficient_stock', productId: 'p1', sku: 'SKU-1', requested: 5, available: 2 },
    ]);
  });
});

describe('OrderService and ReservationService', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let t: Tenants;
  let product: string;
  let warehouse: string;

  beforeAll(async () => {
    app = await createTestApp();
    uow = app.get(UnitOfWork);
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

  const place = (actor: Actor, quantity: number, now = new Date()) =>
    uow.withTransaction((tx) =>
      app.get(CreateOrderUseCase).execute(tx, actor, { warehouseId: warehouse, items: [{ productId: product, quantity }] }, now),
    );

  it('diagnoses an order by code, within scope only', async () => {
    const { buyerA, buyerB, ops } = actorsOf(t);
    const order = await place(buyerA, 3);
    const orders = app.get(OrderService);

    const report = await orders.diagnose(uow.db, orgScopeOf(ops), order.orderCode.toLowerCase());
    expect(report.order.id).toBe(order.id);
    expect(report.reservations).toEqual([expect.objectContaining({ status: 'held', quantity: 3 })]);
    expect(report.blockers[0]).toEqual({ kind: 'awaiting_payment' });

    await expect(orders.diagnose(uow.db, orgScopeOf(buyerB), order.orderCode)).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
  });

  it('a cancelled order reports which lines stock could no longer cover', async () => {
    const { buyerA } = actorsOf(t);
    const order = await place(buyerA, 8);
    await uow.withTransaction((tx) => app.get(CancelOrderUseCase).execute(tx, buyerA, { orderId: order.id }));
    await place(buyerA, 5); // leaves 5 available, fewer than the cancelled 8

    const report = await app.get(OrderService).diagnose(uow.db, orgScopeOf(buyerA), order.orderCode);
    expect(report.blockers).toEqual([
      { kind: 'closed', status: 'cancelled' },
      { kind: 'insufficient_stock', productId: product, sku: 'SKU-1', requested: 8, available: 5 },
    ]);
  });

  it('lists reservations expiring soon, only for reserved orders in scope', async () => {
    const { buyerA, buyerB, ops } = actorsOf(t);
    // Placed 25 minutes ago with a 30-minute hold: 5 minutes left.
    const soon = await place(buyerA, 1, new Date(Date.now() - 25 * 60_000));
    await place(buyerA, 1); // 30 minutes left: outside a 10-minute window
    await place(buyerB, 1, new Date(Date.now() - 25 * 60_000));

    const reservations = app.get(ReservationService);
    const forA = await reservations.listExpiring(uow.db, orgScopeOf(buyerA), 10);
    expect(forA.map((r) => r.orderCode)).toEqual([soon.orderCode]);
    expect(forA[0]).toMatchObject({ sku: 'SKU-1', quantity: 1, buyerOrgId: t.buyerA });

    const forOps = await reservations.listExpiring(uow.db, orgScopeOf(ops), 10);
    expect(forOps).toHaveLength(2);
  });
});
