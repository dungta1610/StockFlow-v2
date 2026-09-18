import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { RecordingHandler, insertOutboxEvent, outboxEventRow } from '../helpers/outbox-fixtures';
import { seedTenants } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * Fan-out (several handlers for one event type) is explicitly out of scope; a
 * second handler declaring an already-bound type is almost certainly a mistake
 * (a new consumer copy-pasting an existing binding) that would otherwise silently
 * replace the first — e.g. a notifications consumer quietly turning off audit
 * logging. The relay refuses instead.
 */
describe('OutboxRelay.registerHandler rejects a duplicate event type', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  const newRelay = () => new OutboxRelay(app.get(UnitOfWork), app.get(ConfigService));

  it('throws when a second handler declares a type that already has one', () => {
    const relay = newRelay();
    relay.registerHandler(new RecordingHandler(['order.custom']));

    expect(() => relay.registerHandler(new RecordingHandler(['order.custom']))).toThrow(/already has a handler/i);
  });

  it('registering the same handler instance twice also throws (no accidental double-bind)', () => {
    const relay = newRelay();
    const handler = new RecordingHandler(['order.custom']);
    relay.registerHandler(handler);

    expect(() => relay.registerHandler(handler)).toThrow(/already has a handler/i);
  });

  it('a handler declaring two types is not partially registered when the second type collides', async () => {
    const t = await seedTenants();
    const relay = newRelay();
    relay.registerHandler(new RecordingHandler(['type.b']));

    expect(() => relay.registerHandler(new RecordingHandler(['type.a', 'type.b']))).toThrow();

    // type.a must never have been bound either — an all-or-nothing check.
    const id = await insertOutboxEvent(t.buyerA, { eventType: 'type.a' });
    const result = await relay.pollOnce();
    expect(result).toEqual({ claimed: 1, processed: 0, failed: 1, dead: 0 });
    expect((await outboxEventRow(id)).last_error).toMatch(/no.*handler/i);
  });
});
