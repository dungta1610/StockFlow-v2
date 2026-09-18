import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import type { Tx } from '../database/tx';
import { UnitOfWork } from '../database/unit-of-work';
import type { OutboxEvent, OutboxHandler } from './outbox-handler.interface';

interface OutboxEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  org_id: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}

const toEvent = (r: OutboxEventRow): OutboxEvent => ({
  id: Number(r.id),
  aggregateType: r.aggregate_type,
  aggregateId: r.aggregate_id,
  eventType: r.event_type,
  orgId: r.org_id,
  payload: r.payload as Record<string, unknown>,
  occurredAt: r.occurred_at,
  attempts: r.attempts,
});

// Doubles per failed attempt, capped, with jitter so many events retrying at once
// do not all wake up in the same instant. Not env-configurable: only the ceiling
// on attempts (OUTBOX_MAX_ATTEMPTS) is an operational knob.
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 30_000;
const backoffMs = (attempts: number): number => {
  const exp = Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);
  return Math.round(exp * (0.75 + Math.random() * 0.5));
};

export interface PollResult {
  claimed: number;
  processed: number;
  failed: number;
  dead: number;
}

/**
 * The "still waiting for work" predicate — shared with `idx_outbox_pending`
 * (migration 006) and with `crash-after-claim.spec.ts`'s hand-written claim, so
 * the real claim query and that test cannot drift apart silently.
 */
export const OUTBOX_PENDING_PREDICATE = `status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())`;

/**
 * Poll → claim → dispatch → mark, all in one transaction (docs/adr/0017).
 *
 * Claim is a row lock (`FOR UPDATE SKIP LOCKED`), taken and released by the same
 * transaction that dispatches and marks the event — never a status update by
 * itself. `attempts` counts failed *dispatches*, never claims: a crash between claim
 * and dispatch rolls the transaction back, the lock is released, and the event
 * returns to `pending` exactly as it was. `status` is the only "has this been
 * handled" predicate; the claim query's WHERE and `idx_outbox_pending` share it.
 *
 * Each event gets its own `SAVEPOINT`. A handler's SQL error aborts the current
 * statement *and* every later statement on that connection until something rolls
 * back — without a savepoint, one bad event would abort the whole claiming
 * transaction, the failure could never be recorded (the recording UPDATE would
 * itself fail against an aborted transaction), and the event would block the head
 * of every future batch forever. `ROLLBACK TO SAVEPOINT` undoes only what that one
 * event's handler did, leaving the rest of the transaction — the other events in
 * the batch, already claimed by the same `FOR UPDATE` — intact.
 *
 * `ORDER BY id` + `SKIP LOCKED` keeps relative order while letting many workers
 * claim different rows at once; it is not a global ordering guarantee, and no
 * handler may assume one.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly handlers = new Map<string, OutboxHandler>();
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly nodeEnv: string;
  private timer?: NodeJS.Timeout;
  /** Guards this instance's own poll loop against overlapping itself; it says
   *  nothing about other relay instances, which claim rows independently. */
  private polling = false;

  constructor(
    private readonly uow: UnitOfWork,
    config: ConfigService<Env, true>,
  ) {
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
    this.maxAttempts = config.get('OUTBOX_MAX_ATTEMPTS', { infer: true });
    this.nodeEnv = config.get('NODE_ENV', { infer: true });
  }

  /**
   * Registers a consumer for its declared event types. One file implementing
   * `OutboxHandler` plus one call here is the whole cost of a new consumer — the
   * relay's polling, retry and dead-letter machinery never changes.
   *
   * Throws if any declared type already has a handler: fan-out (several handlers
   * for one event type) is out of scope, so a second binding for the same type is
   * almost always a mistake — a copy-pasted registration that would otherwise
   * silently replace the first with no error (e.g. a notifications consumer quietly
   * turning off audit logging). All-or-nothing: a handler declaring several types
   * is never partially registered.
   */
  registerHandler(handler: OutboxHandler): void {
    for (const type of handler.eventTypes) {
      if (this.handlers.has(type)) {
        throw new Error(`Outbox event type "${type}" already has a handler registered.`);
      }
    }
    for (const type of handler.eventTypes) this.handlers.set(type, handler);
  }

  /** Background polling never starts under test: specs call `pollOnce()` directly
   *  so results are deterministic and no stray timer touches truncated tables. */
  onApplicationBootstrap(): void {
    if (this.nodeEnv !== 'test') this.start();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch((err: unknown) => {
        // Any rejection here — a poisoned event that somehow still escapes the
        // per-event savepoint, a lost connection, a DB restart — must not become
        // an unhandled rejection: Node has no default handler installed for one,
        // and it would take the whole process down (matches SchedulerRunner.tick).
        this.logger.error(`Outbox poll failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Claims and dispatches up to one batch of pending events. Safe to call
   *  concurrently from independent relay instances — each opens its own
   *  transaction and `SKIP LOCKED` keeps them from claiming the same row. */
  async pollOnce(): Promise<PollResult> {
    if (this.polling) return { claimed: 0, processed: 0, failed: 0, dead: 0 };
    this.polling = true;
    try {
      return await this.uow.withTransaction((tx) => this.claimAndDispatch(tx));
    } finally {
      this.polling = false;
    }
  }

  private async claimAndDispatch(tx: Tx): Promise<PollResult> {
    const rows = await tx.query<OutboxEventRow>(
      `SELECT id, aggregate_type, aggregate_id, event_type, org_id, payload, occurred_at, attempts
         FROM outbox_events
        WHERE ${OUTBOX_PENDING_PREDICATE}
        ORDER BY id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [this.batchSize],
    );

    let processed = 0;
    let failed = 0;
    let dead = 0;
    for (const row of rows) {
      const event = toEvent(row);
      // A savepoint per event: a handler's SQL error only aborts back to here, not
      // the whole claiming transaction, so the events around it — and the failure
      // bookkeeping for this one — are never lost with it.
      await tx.query('SAVEPOINT outbox_event');
      try {
        const handler = this.handlers.get(event.eventType);
        // No handler is a failure, never a silent "processed": a rolling deploy
        // with a stale binding, or a future event type nobody wired up yet, must
        // not look like successful, permanent delivery.
        if (!handler) throw new Error(`No outbox handler registered for event type "${event.eventType}"`);
        await handler.handle(tx, event);
        await tx.query(`UPDATE outbox_events SET status = 'processed', processed_at = now() WHERE id = $1`, [
          event.id,
        ]);
        await tx.query('RELEASE SAVEPOINT outbox_event');
        processed++;
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT outbox_event');
        failed++;
        if (await this.recordFailure(tx, event, err)) dead++;
      }
    }
    return { claimed: rows.length, processed, failed, dead };
  }

  /** Returns whether this failure pushed the event to `dead`. */
  private async recordFailure(tx: Tx, event: OutboxEvent, err: unknown): Promise<boolean> {
    const attempts = event.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Outbox event ${event.id} (${event.eventType}) failed on attempt ${attempts}: ${message}`);

    if (attempts >= this.maxAttempts) {
      await tx.query(
        `UPDATE outbox_events
            SET status = 'dead', attempts = $2, last_error = $3, next_attempt_at = NULL
          WHERE id = $1`,
        [event.id, attempts, message],
      );
      return true;
    }
    await tx.query(
      `UPDATE outbox_events
          SET attempts = $2, last_error = $3, next_attempt_at = now() + ($4 * interval '1 millisecond')
        WHERE id = $1`,
      [event.id, attempts, message, backoffMs(attempts)],
    );
    return false;
  }
}
