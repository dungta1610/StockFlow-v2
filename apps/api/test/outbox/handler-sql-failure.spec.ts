import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Tx } from '../../src/platform/database/tx';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import type { OutboxEvent, OutboxHandler } from '../../src/platform/outbox/outbox-handler.interface';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import type { Env } from '../../src/platform/config/env.schema';
import { configWithOverrides } from '../helpers/config-fixtures';
import { seedTenants } from '../helpers/identity-fixtures';
import { idempotencyKeyExists, insertOutboxEvent, outboxEventRow, setOutboxEventAttempts } from '../helpers/outbox-fixtures';
import { createTestApp } from '../helpers/test-app';

/** Fails every call with a real SQL error (not a thrown JS `Error`) — this is what
 *  a constraint violation, a statement timeout, or an FK failure inside a handler
 *  actually looks like: the whole surrounding transaction is aborted at the
 *  Postgres level ("current transaction is aborted") unless something rolls back
 *  to a savepoint first. */
class SqlFailingHandler implements OutboxHandler {
  readonly eventTypes = ['test.sql-fail'];
  async handle(tx: Tx): Promise<void> {
    await tx.query('SELECT 1/0');
  }
}

/** Writes a real, cross-session-visible row, then throws a plain JS error. Proves
 *  a handler's writes and its failure are rolled back together — not committed
 *  with only the failure bookkeeping surviving. */
class WritesThenThrowsHandler implements OutboxHandler {
  readonly eventTypes = ['test.writes-then-throws'];
  constructor(private readonly orgId: string) {}
  async handle(tx: Tx): Promise<void> {
    await tx.query(
      `INSERT INTO idempotency_keys (org_id, endpoint, key, request_hash) VALUES ($1, 'test-probe', 'poison-key', 'hash')`,
      [this.orgId],
    );
    throw new Error('boom after write');
  }
}

class RecordingHandler implements OutboxHandler {
  readonly eventTypes = ['test.ok'];
  readonly calls: OutboxEvent[] = [];
  async handle(_tx: Tx, event: OutboxEvent): Promise<void> {
    this.calls.push(event);
  }
}

describe('a handler whose SQL fails does not poison the batch or lose the failure', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  const newRelay = (overrides: Partial<Env> = {}) =>
    new OutboxRelay(app.get(UnitOfWork), configWithOverrides(app.get(ConfigService), overrides));

  it('a real SQL error in the middle of a batch: the others still end processed, the poisoned one is recorded as a failure', async () => {
    const t = await seedTenants();
    const relay = newRelay();
    const ok = new RecordingHandler();
    relay.registerHandler(new SqlFailingHandler());
    relay.registerHandler(ok);

    const before = await insertOutboxEvent(t.buyerA, { eventType: 'test.ok', payload: { n: 'before' } });
    const poisoned = await insertOutboxEvent(t.buyerA, { eventType: 'test.sql-fail' });
    const after = await insertOutboxEvent(t.buyerA, { eventType: 'test.ok', payload: { n: 'after' } });

    const result = await relay.pollOnce();

    expect(result).toEqual({ claimed: 3, processed: 2, failed: 1, dead: 0 });
    expect(ok.calls.map((e) => e.payload)).toEqual([{ n: 'before' }, { n: 'after' }]);
    expect((await outboxEventRow(before)).status).toBe('processed');
    expect((await outboxEventRow(after)).status).toBe('processed');
    const poisonedRow = await outboxEventRow(poisoned);
    expect(poisonedRow.status).toBe('pending');
    expect(poisonedRow.attempts).toBe(1);
    expect(poisonedRow.last_error).toMatch(/division by zero/i);
  });

  it('the same SQL failure reaches dead once attempts hits OUTBOX_MAX_ATTEMPTS', async () => {
    const t = await seedTenants();
    const relay = newRelay({ OUTBOX_MAX_ATTEMPTS: 2 });
    relay.registerHandler(new SqlFailingHandler());
    const id = await insertOutboxEvent(t.buyerA, { eventType: 'test.sql-fail' });
    await setOutboxEventAttempts(id, 1);

    await relay.pollOnce();

    const row = await outboxEventRow(id);
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(2);
    expect(row.next_attempt_at).toBeNull();
    expect(row.last_error).toMatch(/division by zero/i);
  });

  it('a handler that writes then throws a JS error has its write rolled back together with the failure', async () => {
    const t = await seedTenants();
    const relay = newRelay();
    relay.registerHandler(new WritesThenThrowsHandler(t.buyerA));
    const id = await insertOutboxEvent(t.buyerA, { eventType: 'test.writes-then-throws' });

    await relay.pollOnce();

    expect(await idempotencyKeyExists('poison-key')).toBe(false);
    const row = await outboxEventRow(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('boom after write');
  });
});
