import type { INestApplication } from '@nestjs/common';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import { seedTenants } from '../helpers/identity-fixtures';
import { insertOutboxEvent, outboxEventRow, setOutboxEventAttempts } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * An event type with no registered handler must never be marked `processed` — that
 * would be a silent, permanent loss (a rolling deploy with a stale binding, or a
 * future event type nobody wired up yet). It goes through the same retry/backoff
 * path as any other failure and eventually reaches `dead`, where `GET
 * /ops/outbox?status=dead` surfaces it.
 */
describe('an outbox event type with no registered handler', () => {
  let app: INestApplication;
  let relay: OutboxRelay;

  beforeAll(async () => {
    app = await createTestApp();
    relay = app.get(OutboxRelay);
  });
  afterAll(() => app.close());

  it('is recorded as a failure, not silently marked processed', async () => {
    const t = await seedTenants();
    const id = await insertOutboxEvent(t.buyerA, { eventType: 'order.refunded' });

    const result = await relay.pollOnce();

    expect(result).toEqual({ claimed: 1, processed: 0, failed: 1, dead: 0 });
    const row = await outboxEventRow(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/no.*handler/i);
    expect(row.last_error).toContain('order.refunded');
  });

  it('eventually goes dead, the same as any other persistent failure', async () => {
    const t = await seedTenants();
    const id = await insertOutboxEvent(t.buyerA, { eventType: 'order.refunded' });
    await setOutboxEventAttempts(id, 7); // one below the default OUTBOX_MAX_ATTEMPTS (8)

    await relay.pollOnce();

    const row = await outboxEventRow(id);
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(8);
  });
});
