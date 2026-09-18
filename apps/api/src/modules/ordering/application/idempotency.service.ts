import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Tx } from '../../../platform/database/tx';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { OrderErrors } from '../domain/errors';
import { type IdempotencyClaim, IdempotencyRepository } from './ports/idempotency.repository';

export interface HttpResult {
  status: number;
  body: unknown;
}

/**
 * Runs a write at most once per (organisation, endpoint, key). The deliberate exception
 * to "callers own the transaction" (ADR 0015): the claim has to commit *before* the
 * work's transaction opens, or a concurrent duplicate would block on — or read around
 * — an uncommitted row. So this service opens its own transactions, and nothing may
 * call it from inside one.
 *
 *   claim     — one autocommit statement: new key or a failed one → ours; else report.
 *   work      — the caller's transaction; the key is marked completed inside it, so a
 *               committed order and a completed key are one atomic fact.
 *   release   — work failed: mark the key failed so the client may retry with it.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly keys: IdempotencyRepository,
  ) {}

  /** Stable fingerprint of a validated request body. */
  static hashRequest(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }

  async execute(claim: IdempotencyClaim, work: (tx: Tx) => Promise<HttpResult>): Promise<HttpResult> {
    const outcome = await this.keys.claim(this.uow.db, claim);
    if (outcome.kind === 'taken') {
      if (outcome.requestHash !== claim.requestHash) throw OrderErrors.idempotencyKeyReused();
      if (outcome.status !== 'completed') throw OrderErrors.idempotencyInProgress();
      return { status: outcome.responseStatus!, body: outcome.responseSnapshot };
    }

    try {
      return await this.uow.withTransaction(async (tx) => {
        const result = await work(tx);
        await this.keys.complete(tx, claim, result.status, result.body);
        return result;
      });
    } catch (err) {
      // If this also fails the key stays in_progress until the TTL cleanup removes it;
      // the client sees 409 IDEMPOTENCY_IN_PROGRESS, never a second order.
      await this.keys.release(this.uow.db, claim).catch((releaseErr: Error) => {
        this.logger.error(`Could not release idempotency key: ${releaseErr.message}`);
      });
      throw err;
    }
  }
}
