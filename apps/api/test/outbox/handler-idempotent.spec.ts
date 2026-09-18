import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditLogHandler } from '../../src/modules/audit/application/audit-log.handler';
import type { OutboxEvent } from '../../src/platform/outbox/outbox-handler.interface';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { seedTenants, withDb } from '../helpers/identity-fixtures';
import { insertOutboxEvent } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('an OutboxHandler is idempotent', () => {
  let app: INestApplication;
  let uow: UnitOfWork;
  let handler: AuditLogHandler;

  beforeAll(async () => {
    app = await createTestApp();
    uow = app.get(UnitOfWork);
    handler = app.get(AuditLogHandler);
  });
  afterAll(() => app.close());

  it('dispatching the same event twice writes exactly one audit_log row', async () => {
    const t = await seedTenants();
    const orderId = randomUUID();
    const eventId = await insertOutboxEvent(t.buyerA, {
      aggregateType: 'order',
      aggregateId: orderId,
      eventType: 'order.cancelled',
      payload: { order_id: orderId, order_code: 'ORD-1', buyer_org_id: t.buyerA, from: 'reserved', to: 'cancelled', actor_user_id: t.users.buyerA },
    });
    const event: OutboxEvent = {
      id: eventId,
      aggregateType: 'order',
      aggregateId: orderId,
      eventType: 'order.cancelled',
      orgId: t.buyerA,
      payload: { order_id: orderId, order_code: 'ORD-1', buyer_org_id: t.buyerA, from: 'reserved', to: 'cancelled', actor_user_id: t.users.buyerA },
      occurredAt: new Date(),
      attempts: 0,
    };

    await uow.withTransaction((tx) => handler.handle(tx, event));
    await uow.withTransaction((tx) => handler.handle(tx, event));

    const rows = await withDb((pg) => pg.query('SELECT * FROM commerce.audit_log WHERE event_id = $1', [eventId]));
    expect(rows.rows).toHaveLength(1);
  });
});
