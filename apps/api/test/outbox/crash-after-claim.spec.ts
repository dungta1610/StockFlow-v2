import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { OUTBOX_PENDING_PREDICATE, OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import { seedTenants } from '../helpers/identity-fixtures';
import { insertOutboxEvent, outboxEventRow, RecordingHandler } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('a crash between claim and dispatch', () => {
  let app: INestApplication;
  let relay: OutboxRelay;

  beforeAll(async () => {
    app = await createTestApp();
    relay = app.get(OutboxRelay);
  });
  afterAll(() => app.close());

  it('leaves the event pending with attempts unchanged, and the next poll processes it normally', async () => {
    const t = await seedTenants();
    const id = await insertOutboxEvent(t.buyerA, { eventType: 'test.event', payload: { ok: true } });

    // Simulate a crash: claim the row exactly like the relay does — same predicate,
    // imported from the relay itself so this can never silently drift from the
    // real claim query — then roll back without dispatching or marking anything;
    // the transaction never commits.
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `SELECT id FROM commerce.outbox_events
          WHERE ${OUTBOX_PENDING_PREDICATE}
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      expect(claimed.rows).toHaveLength(1);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    const afterCrash = await outboxEventRow(id);
    expect(afterCrash).toMatchObject({ status: 'pending', attempts: 0, processed_at: null });

    const handler = new RecordingHandler(['test.event']);
    relay.registerHandler(handler);
    const result = await relay.pollOnce();

    expect(result).toEqual({ claimed: 1, processed: 1, failed: 0, dead: 0 });
    expect(handler.calls).toHaveLength(1);
    const afterPoll = await outboxEventRow(id);
    expect(afterPoll).toMatchObject({ status: 'processed', attempts: 0 });
    expect(afterPoll.processed_at).not.toBeNull();
  });
});
