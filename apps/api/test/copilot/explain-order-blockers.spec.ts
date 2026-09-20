import type { INestApplication } from '@nestjs/common';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { CreateOrderUseCase } from '../../src/modules/ordering/application/use-cases/create-order.use-case';
import { MarkOrderPaidUseCase } from '../../src/modules/ordering/application/use-cases/order-transition.use-cases';
import { withDb } from '../helpers/identity-fixtures';
import { actorsOf, stockUp } from '../helpers/ordering-fixtures';
import { createCopilotApp, seedCopilotWorld, toolFor, type CopilotWorld } from '../helpers/copilot-fixtures';

interface Blockers {
  orderCode: string;
  status: string;
  blockers: Array<{ kind: string }>;
  nextStatuses: string[];
  heldReservations: Array<{ sku: string; quantity: number }>;
}

/**
 * "Why is this order stuck?" — the question the copilot exists to answer.
 *
 * The tool returns the diagnosis as structure, not prose. A model asked to
 * re-derive "it is unpaid and the hold expires in eleven minutes" from raw rows
 * will eventually get it wrong; a model relaying a computed answer will not.
 */
describe('explain_order_blockers', () => {
  let app: INestApplication;
  let world: CopilotWorld;
  let orderId: string;
  let orderCode: string;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    world = await seedCopilotWorld();
    await stockUp(app, world, world.productId, world.warehouseId, 20);
    const order = await app.get(UnitOfWork).withTransaction((tx) =>
      app.get(CreateOrderUseCase).execute(
        tx,
        actorsOf(world).buyerA,
        { warehouseId: world.warehouseId, items: [{ productId: world.productId, quantity: 3 }] },
        new Date(),
      ),
    );
    orderId = order.id;
    orderCode = order.orderCode;
  });

  const explain = (): Promise<Blockers> =>
    toolFor(app, 'explain_order_blockers', actorsOf(world).ops).handler({ orderCode }) as Promise<Blockers>;

  it('says a reserved order is waiting to be paid, and what it is holding', async () => {
    const report = await explain();

    expect(report.status).toBe('reserved');
    expect(report.blockers.map((b) => b.kind)).toContain('awaiting_payment');
    expect(report.heldReservations).toEqual([{ sku: 'SKU-1', quantity: 3, expiresAt: expect.any(String) }]);
    expect(report.nextStatuses).toContain('paid');
  });

  it('flags a hold that is already overdue', async () => {
    await withDb((pg) =>
      pg.query(`UPDATE commerce.orders SET reservation_expires_at = now() - interval '5 minutes' WHERE id = $1`, [
        orderId,
      ]),
    );

    const report = await explain();
    expect(report.blockers.map((b) => b.kind)).toContain('reservation_overdue');
  });

  it('flags a hold that is about to expire, with how long is left', async () => {
    await withDb((pg) =>
      pg.query(`UPDATE commerce.orders SET reservation_expires_at = now() + interval '10 minutes' WHERE id = $1`, [
        orderId,
      ]),
    );

    const report = await explain();
    const expiring = report.blockers.find((b) => b.kind === 'reservation_expiring');
    expect(expiring).toMatchObject({ minutesLeft: expect.any(Number) });
  });

  it('stops naming payment once the order is paid', async () => {
    await app
      .get(UnitOfWork)
      .withTransaction((tx) => app.get(MarkOrderPaidUseCase).execute(tx, actorsOf(world).ops, { orderId }));

    const report = await explain();
    expect(report.status).toBe('paid');
    expect(report.blockers.map((b) => b.kind)).not.toContain('awaiting_payment');
  });

  it('reads an unknown order code as not found, not as an empty answer', async () => {
    const tool = toolFor(app, 'explain_order_blockers', actorsOf(world).ops);
    await expect(tool.handler({ orderCode: 'ORD-999999' })).rejects.toMatchObject({ status: 404 });
  });
});
