import type { INestApplication } from '@nestjs/common';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import { withDb, seedTenants } from '../helpers/identity-fixtures';
import { insertOutboxEvent, RecordingHandler } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * `status` is the only "has this been handled" predicate: the claim query's WHERE
 * and idx_outbox_pending's partial-index predicate are the same condition, so
 * there is exactly one place that decides what still needs work.
 */
describe('outbox status is the single source of truth', () => {
  let app: INestApplication;
  let relay: OutboxRelay;

  beforeAll(async () => {
    app = await createTestApp();
    relay = app.get(OutboxRelay);
  });
  afterAll(() => app.close());

  it('leaves no processed row without processed_at, and none matching the pending predicate', async () => {
    const t = await seedTenants();
    const handler = new RecordingHandler(['test.event']);
    relay.registerHandler(handler);
    for (let i = 0; i < 25; i++) await insertOutboxEvent(t.buyerA, { eventType: 'test.event', payload: { n: i } });

    for (;;) {
      const r = await relay.pollOnce();
      if (r.claimed === 0) break;
    }

    const invariant = await withDb((pg) =>
      pg.query(`
        SELECT
          (SELECT count(*) FROM commerce.outbox_events WHERE status = 'processed' AND processed_at IS NULL) AS orphaned_processed,
          (SELECT count(*) FROM commerce.outbox_events WHERE status = 'pending') AS still_pending
      `),
    );
    expect(invariant.rows[0]).toEqual({ orphaned_processed: '0', still_pending: '0' });
    expect(handler.calls).toHaveLength(25);
  });
});
