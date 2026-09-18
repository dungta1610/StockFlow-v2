import type { INestApplication } from '@nestjs/common';
import type { Tx } from '../../src/platform/database/tx';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import type { OutboxEvent, OutboxHandler } from '../../src/platform/outbox/outbox-handler.interface';
import { seedTenants } from '../helpers/identity-fixtures';
import { insertOutboxEvent, outboxEventRow } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

/** Always fails; used to prove one poisoned event does not stop the rest of its batch. */
class AlwaysFailsHandler implements OutboxHandler {
  readonly eventTypes = ['test.always-fails'];
  async handle(): Promise<void> {
    throw new Error('always fails');
  }
}

class RecordingHandler implements OutboxHandler {
  readonly eventTypes = ['test.ok'];
  readonly calls: OutboxEvent[] = [];
  async handle(_tx: Tx, event: OutboxEvent): Promise<void> {
    this.calls.push(event);
  }
}

describe('a failing event does not block the events after it', () => {
  let app: INestApplication;
  let relay: OutboxRelay;

  beforeAll(async () => {
    app = await createTestApp();
    relay = app.get(OutboxRelay);
  });
  afterAll(() => app.close());

  it('processes ok events in the same batch as a poisoned one', async () => {
    const t = await seedTenants();
    const ok = new RecordingHandler();
    relay.registerHandler(new AlwaysFailsHandler());
    relay.registerHandler(ok);

    const before = await insertOutboxEvent(t.buyerA, { eventType: 'test.ok', payload: { n: 'before' } });
    const poisoned = await insertOutboxEvent(t.buyerA, { eventType: 'test.always-fails' });
    const after = await insertOutboxEvent(t.buyerA, { eventType: 'test.ok', payload: { n: 'after' } });

    const result = await relay.pollOnce();

    expect(result).toEqual({ claimed: 3, processed: 2, failed: 1, dead: 0 });
    expect(ok.calls.map((e) => e.payload)).toEqual([{ n: 'before' }, { n: 'after' }]);
    expect((await outboxEventRow(before)).status).toBe('processed');
    expect((await outboxEventRow(after)).status).toBe('processed');
    const poisonedRow = await outboxEventRow(poisoned);
    expect(poisonedRow.status).toBe('pending');
    expect(poisonedRow.attempts).toBe(1);
  });
});
