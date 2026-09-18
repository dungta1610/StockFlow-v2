import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { configWithOverrides } from '../helpers/config-fixtures';
import { seedTenants } from '../helpers/identity-fixtures';
import { FailingHandler, insertOutboxEvent, outboxEventRow, setOutboxEventAttempts } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('failed dispatch: backoff then dead-letter', () => {
  let app: INestApplication;
  let relay: OutboxRelay;

  beforeAll(async () => {
    app = await createTestApp();
    // OUTBOX_MAX_ATTEMPTS=3 so the test proves dead-lettering without waiting out
    // several real backoff cycles at the default of 8.
    relay = new OutboxRelay(app.get(UnitOfWork), configWithOverrides(app.get(ConfigService), { OUTBOX_MAX_ATTEMPTS: 3 }));
    // registerHandler throws on a duplicate event type (H3), so this is registered
    // once and shared: "always fails" behaviour doesn't depend on per-test state.
    relay.registerHandler(new FailingHandler(['test.event'], Infinity));
  });
  afterAll(() => app.close());

  it('increments attempts and pushes next_attempt_at into the future on failure', async () => {
    const t = await seedTenants();
    const id = await insertOutboxEvent(t.buyerA, { eventType: 'test.event' });

    let row = await outboxEventRow(id);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: null });

    const before = Date.now();
    const result = await relay.pollOnce();
    expect(result).toEqual({ claimed: 1, processed: 0, failed: 1, dead: 0 });

    row = await outboxEventRow(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.processed_at).toBeNull();
    expect(row.next_attempt_at).not.toBeNull();
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(before);
  });

  it('marks the event dead once attempts reaches OUTBOX_MAX_ATTEMPTS, dropping it out of the pending queue', async () => {
    const t = await seedTenants();
    const id = await insertOutboxEvent(t.buyerA, { eventType: 'test.event' });
    // Seeded one attempt below the override's max of 3, immediately claimable —
    // proves the boundary without waiting through real exponential backoff delays.
    await setOutboxEventAttempts(id, 2);

    await relay.pollOnce();

    const row = await outboxEventRow(id);
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(3);
    expect(row.next_attempt_at).toBeNull();
    expect(row.processed_at).toBeNull();
    expect(row.last_error).toContain('synthetic failure');

    const after = await relay.pollOnce();
    expect(after.claimed).toBe(0);
  });
});
