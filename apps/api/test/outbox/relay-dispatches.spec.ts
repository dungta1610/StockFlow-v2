import type { INestApplication } from '@nestjs/common';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import { seedTenants } from '../helpers/identity-fixtures';
import { insertOutboxEvent, outboxEventRow, RecordingHandler } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

describe('outbox relay dispatch', () => {
  let app: INestApplication;
  let relay: OutboxRelay;

  beforeAll(async () => {
    app = await createTestApp();
    relay = app.get(OutboxRelay);
  });
  afterAll(() => app.close());

  it('dispatches every pending event exactly once, in order, to the matching handler', async () => {
    const t = await seedTenants();
    const handler = new RecordingHandler(['test.event']);
    relay.registerHandler(handler);
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push(await insertOutboxEvent(t.buyerA, { eventType: 'test.event', payload: { n: i } }));

    const result = await relay.pollOnce();

    expect(result).toEqual({ claimed: 3, processed: 3, failed: 0, dead: 0 });
    expect(handler.calls.map((e) => e.payload)).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
    for (const id of ids) {
      const row = await outboxEventRow(id);
      expect(row.status).toBe('processed');
      expect(row.processed_at).not.toBeNull();
    }
  });

  it('adding a second handler is one file plus one registerHandler() call', async () => {
    const t = await seedTenants();
    const orders = new RecordingHandler(['test.order-event']);
    // The "second file" — any class implementing OutboxHandler — registered with a
    // single extra call, with no change anywhere else in the relay.
    const shipments = new RecordingHandler(['test.shipment-event']);
    relay.registerHandler(orders);
    relay.registerHandler(shipments);

    await insertOutboxEvent(t.buyerA, { eventType: 'test.order-event', payload: { kind: 'order' } });
    await insertOutboxEvent(t.buyerA, { eventType: 'test.shipment-event', payload: { kind: 'shipment' } });

    const result = await relay.pollOnce();

    expect(result).toEqual({ claimed: 2, processed: 2, failed: 0, dead: 0 });
    expect(orders.calls).toHaveLength(1);
    expect(shipments.calls).toHaveLength(1);
  });
});
