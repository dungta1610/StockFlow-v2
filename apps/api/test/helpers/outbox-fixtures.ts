import { randomUUID } from 'node:crypto';
import type { Tx } from '../../src/platform/database/tx';
import type { OutboxEvent, OutboxHandler } from '../../src/platform/outbox/outbox-handler.interface';
import { withDb } from './identity-fixtures';

export interface NewOutboxEventOverrides {
  aggregateType?: string;
  aggregateId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
}

/** Inserts a row directly, bypassing OutboxRepository — for tests driving the relay
 *  without going through a full use case. Returns the assigned id. */
export async function insertOutboxEvent(orgId: string, overrides: NewOutboxEventOverrides = {}): Promise<number> {
  return withDb(async (pg) => {
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO commerce.outbox_events (aggregate_type, aggregate_id, event_type, org_id, payload)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        overrides.aggregateType ?? 'test',
        overrides.aggregateId ?? randomUUID(),
        overrides.eventType ?? 'test.event',
        orgId,
        JSON.stringify(overrides.payload ?? {}),
      ],
    );
    return Number(rows[0]!.id);
  });
}

export interface OutboxEventDbRow {
  status: 'pending' | 'processed' | 'dead';
  attempts: number;
  next_attempt_at: Date | null;
  processed_at: Date | null;
  last_error: string | null;
}

export function outboxEventRow(id: number): Promise<OutboxEventDbRow> {
  return withDb(async (pg) => {
    const { rows } = await pg.query<OutboxEventDbRow>(
      `SELECT status, attempts, next_attempt_at, processed_at, last_error
         FROM commerce.outbox_events WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  });
}

/** Forces a row to a given attempts count and immediately claimable — lets a test
 *  reach a specific point in the retry/dead-letter progression without waiting
 *  through real exponential backoff delays. */
export async function setOutboxEventAttempts(id: number, attempts: number): Promise<void> {
  await withDb((pg) =>
    pg.query(`UPDATE commerce.outbox_events SET attempts = $2, next_attempt_at = NULL WHERE id = $1`, [id, attempts]),
  );
}

/** A row this test wrote directly to a real table, so a rollback (SAVEPOINT or
 *  whole-transaction) is provable from a separate connection regardless of which
 *  physical pool connection later reads it back (a temp table would not be). */
export function idempotencyKeyExists(key: string): Promise<boolean> {
  return withDb(async (pg) => {
    const { rows } = await pg.query('SELECT 1 FROM commerce.idempotency_keys WHERE key = $1', [key]);
    return rows.length > 0;
  });
}

/** Records every event it is given, in call order; never fails. */
export class RecordingHandler implements OutboxHandler {
  readonly calls: OutboxEvent[] = [];
  constructor(readonly eventTypes: string[]) {}
  async handle(_tx: Tx, event: OutboxEvent): Promise<void> {
    this.calls.push(event);
  }
}

/** Fails its first `failTimes` calls, then succeeds. */
export class FailingHandler implements OutboxHandler {
  attempts = 0;
  constructor(
    readonly eventTypes: string[],
    private readonly failTimes: number,
  ) {}
  async handle(): Promise<void> {
    this.attempts++;
    if (this.attempts <= this.failTimes) throw new Error(`synthetic failure #${this.attempts}`);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
