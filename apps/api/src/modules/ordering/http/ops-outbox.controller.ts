import { Controller, Get, Query } from '@nestjs/common';
import { type ListOutboxEventsQuery, type OutboxEventView, listOutboxEventsQuerySchema } from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { OrgScope } from '../../identity/domain/org-scope';
import { CurrentScope, Roles } from '../../identity/http/auth.decorators';
import { type OutboxEventRecord, OutboxRepository } from '../application/ports/outbox.repository';

const present = (r: OutboxEventRecord): OutboxEventView => ({
  id: r.id,
  aggregate_type: r.aggregateType,
  aggregate_id: r.aggregateId,
  event_type: r.eventType,
  org_id: r.orgId,
  status: r.status,
  attempts: r.attempts,
  last_error: r.lastError,
  next_attempt_at: r.nextAttemptAt ? r.nextAttemptAt.toISOString() : null,
  occurred_at: r.occurredAt.toISOString(),
  processed_at: r.processedAt ? r.processedAt.toISOString() : null,
});

/** The outbox relay's queue, for an operator watching for stuck or dead events. */
@Controller('ops/outbox')
@Roles('ops_admin')
export class OpsOutboxController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxRepository,
  ) {}

  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @Query(new ZodValidationPipe(listOutboxEventsQuerySchema)) q: ListOutboxEventsQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const events = await this.outbox.listByStatus(this.uow.db, scope, q.status, paging);
    return { data: events.map(present), paging };
  }
}
