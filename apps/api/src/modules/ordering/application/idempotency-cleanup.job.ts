import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../platform/config/env.schema';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Job } from '../../../platform/scheduler/job.interface';
import { SchedulerRunner } from '../../../platform/scheduler/scheduler.runner';
import { IdempotencyRepository } from './ports/idempotency.repository';

/** Not exposed as an env var: cleanup timing is not operationally sensitive the way
 *  the outbox poll or reservation sweep intervals are. */
const RUN_EVERY_MS = 60 * 60 * 1_000;

/**
 * Deletes idempotency keys older than `IDEMPOTENCY_TTL_HOURS` (docs/adr/0015),
 * bounding the table's growth. A key stuck `in_progress` because its worker died
 * is also removed once its TTL passes — the client sees the same result it always
 * would (a fresh claim, since the row is gone) rather than a permanent 409.
 */
@Injectable()
export class IdempotencyCleanupJob implements Job, OnApplicationBootstrap {
  readonly name = 'idempotency-cleanup';
  private readonly logger = new Logger(IdempotencyCleanupJob.name);
  private readonly ttlHours: number;
  private readonly nodeEnv: string;

  constructor(
    private readonly scheduler: SchedulerRunner,
    private readonly uow: UnitOfWork,
    private readonly idempotency: IdempotencyRepository,
    config: ConfigService<Env, true>,
  ) {
    this.ttlHours = config.get('IDEMPOTENCY_TTL_HOURS', { infer: true });
    this.nodeEnv = config.get('NODE_ENV', { infer: true });
  }

  /** Never scheduled under test: specs call `run()` directly. */
  onApplicationBootstrap(): void {
    if (this.nodeEnv !== 'test') this.scheduler.schedule(this, RUN_EVERY_MS);
  }

  async run(): Promise<void> {
    const before = new Date(Date.now() - this.ttlHours * 3_600_000);
    const deleted = await this.uow.withTransaction((tx) => this.idempotency.deleteExpired(tx, before));
    if (deleted > 0) this.logger.log(`Deleted ${deleted} expired idempotency key(s).`);
  }
}
