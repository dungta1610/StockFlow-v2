import { Controller, Get, Query } from '@nestjs/common';
import { type AuditLogView, type ListAuditLogQuery, listAuditLogQuerySchema } from '@stockflow/contracts';
import { UnitOfWork } from '../../../platform/database/unit-of-work';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { OrgScope } from '../../identity/domain/org-scope';
import { CurrentScope, Roles } from '../../identity/http/auth.decorators';
import { type AuditLogRow, SqlAuditRepository } from '../infrastructure/sql-audit.repository';

const present = (r: AuditLogRow): AuditLogView => ({
  id: r.id,
  event_id: r.eventId,
  aggregate_type: r.aggregateType,
  aggregate_id: r.aggregateId,
  event_type: r.eventType,
  org_id: r.orgId,
  actor_user_id: r.actorUserId,
  summary: r.summary,
  occurred_at: r.occurredAt.toISOString(),
  recorded_at: r.recordedAt.toISOString(),
});

/** Read-only projection of the outbox, filtered per event type (docs/adr/0019). */
@Controller('ops/audit')
@Roles('ops_admin')
export class AuditController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: SqlAuditRepository,
  ) {}

  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @Query(new ZodValidationPipe(listAuditLogQuerySchema)) q: ListAuditLogQuery,
  ) {
    const paging = { page: q.page, limit: q.limit };
    const rows = await this.audit.list(
      this.uow.db,
      scope,
      { aggregateType: q.aggregate_type, aggregateId: q.aggregate_id, eventType: q.event_type },
      paging,
    );
    return { data: rows.map(present), paging };
  }
}
