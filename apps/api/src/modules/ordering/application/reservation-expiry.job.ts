import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../platform/config/env.schema';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Job } from '../../../platform/scheduler/job.interface';
import { SchedulerRunner } from '../../../platform/scheduler/scheduler.runner';
import { systemActor } from '../../identity/domain/actor';
import { ExpireOrderUseCase } from './use-cases/order-transition.use-cases';
import { type ExpiryCursor, OrderRepository } from './ports/order.repository';

/**
 * Releases stock an order has held past its reservation deadline (docs/adr/0018).
 *
 * Reads the ids to expire with a plain read outside any transaction, then gives
 * each order its own `withTransaction` call into `ExpireOrderUseCase` — the same
 * use case `POST /orders/:id/expire` uses, as `systemActor` (ops rights over every
 * buyer organisation). The order's row lock, taken inside that transaction, is the
 * claim: there is no intermediate "releasing" state, and no second connection ever
 * waits on a lock this sweep itself is holding — the failure mode a nested
 * transaction would create (docs/adr/0004).
 *
 * A batch limits how many ORDERS one run touches, never how many lines of one
 * order: `OrderTransitions.apply` settles a whole order's reservations or none of
 * them. Two sweeps racing the same order serialise on that order's row lock; the
 * second one finds it already `expired` and returns unchanged (Order lifecycle
 * transitions are idempotent — docs/adr/0016).
 *
 * A cursor (soonest-expiring order last touched) advances after every order this
 * job attempts, whether it succeeded or failed, and only resets once a run reads
 * fewer than a full batch (it reached the end of the currently expired set). This
 * is what stops a persistently failing order from crowding out every order behind
 * it: without it, the same failing ids would head every future run's `ORDER BY …
 * LIMIT batch` forever, and orders behind them would never get a turn.
 */
@Injectable()
export class ReservationExpiryJob implements Job, OnApplicationBootstrap {
  readonly name = 'reservation-expiry';
  private readonly logger = new Logger(ReservationExpiryJob.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly nodeEnv: string;
  private cursor: ExpiryCursor | null = null;

  constructor(
    private readonly scheduler: SchedulerRunner,
    private readonly uow: UnitOfWork,
    private readonly orders: OrderRepository,
    private readonly expireOrder: ExpireOrderUseCase,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.get('RESERVATION_SWEEP_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('RESERVATION_SWEEP_BATCH', { infer: true });
    this.nodeEnv = config.get('NODE_ENV', { infer: true });
  }

  /** Never scheduled under test: specs call `run()` directly. */
  onApplicationBootstrap(): void {
    if (this.nodeEnv !== 'test') this.scheduler.schedule(this, this.intervalMs);
  }

  async run(): Promise<void> {
    const page = await this.orders.listReservedExpired(this.uow.db, new Date(), this.batchSize, this.cursor);
    for (const order of page) {
      try {
        await this.uow.withTransaction((tx) => this.expireOrder.execute(tx, systemActor, { orderId: order.id }));
      } catch (err) {
        // One order's lock contention (bounded by lock_timeout, 5s by default —
        // docs/adr/0004) or failure must not stop the sweep from reaching the rest
        // of the batch.
        this.logger.error(`Failed to expire order ${order.id}: ${(err as Error).message}`);
      } finally {
        // Advance past this order regardless of outcome: a failing order must
        // never keep re-claiming the front of every future run.
        this.cursor = { expiresAt: order.reservationExpiresAt, id: order.id };
      }
    }
    // Reached the end of the currently expired set: restart from the top next run
    // so newly-expired orders are picked up too.
    if (page.length < this.batchSize) this.cursor = null;
  }
}
