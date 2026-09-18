import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { seedTenants } from '../helpers/identity-fixtures';
import { insertOutboxEvent, RecordingHandler } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * Two independent relay instances stand in for two relay processes: each opens its
 * own transaction per `pollOnce()`, so `FOR UPDATE SKIP LOCKED` is exercised for
 * real, not merely simulated by one instance's in-process guard.
 */
describe('two relays polling concurrently', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('dispatches each of 100 events exactly once, none skipped', async () => {
    const t = await seedTenants();
    const handler = new RecordingHandler(['test.event']);
    const relayA = new OutboxRelay(app.get(UnitOfWork), app.get(ConfigService));
    const relayB = new OutboxRelay(app.get(UnitOfWork), app.get(ConfigService));
    relayA.registerHandler(handler);
    relayB.registerHandler(handler);

    const total = 100;
    for (let i = 0; i < total; i++) {
      await insertOutboxEvent(t.buyerA, { eventType: 'test.event', payload: { n: i } });
    }

    const drain = async (relay: OutboxRelay): Promise<number> => {
      let claimed = 0;
      for (;;) {
        const r = await relay.pollOnce();
        claimed += r.claimed;
        if (r.claimed === 0) break;
      }
      return claimed;
    };

    const [a, b] = await Promise.all([drain(relayA), drain(relayB)]);

    expect(a + b).toBe(total);
    expect(handler.calls).toHaveLength(total);
    const ns = handler.calls.map((e) => (e.payload as { n: number }).n).sort((x, y) => x - y);
    expect(ns).toEqual(Array.from({ length: total }, (_, i) => i));
  });
});
