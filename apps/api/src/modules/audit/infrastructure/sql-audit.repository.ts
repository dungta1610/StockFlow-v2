import { Injectable } from '@nestjs/common';
import { type Paging, pagingSql, paramBinder } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import type { OrgScope } from '../../identity/domain/org-scope';

export interface AuditLogFilter {
  aggregateType?: string;
  aggregateId?: string;
  eventType?: string;
}

export interface AuditLogRow {
  id: number;
  eventId: number;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  orgId: string;
  actorUserId: string | null;
  summary: Record<string, unknown>;
  occurredAt: Date;
  recordedAt: Date;
}

interface Row {
  id: string;
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  org_id: string;
  actor_user_id: string | null;
  summary: Record<string, unknown>;
  occurred_at: Date;
  recorded_at: Date;
}

const toRow = (r: Row): AuditLogRow => ({
  id: Number(r.id),
  eventId: Number(r.event_id),
  aggregateType: r.aggregate_type,
  aggregateId: r.aggregate_id,
  eventType: r.event_type,
  orgId: r.org_id,
  actorUserId: r.actor_user_id,
  summary: r.summary,
  occurredAt: r.occurred_at,
  recordedAt: r.recorded_at,
});

/** audit_log has no org_type column: its org_id is copied from outbox_events.org_id,
 *  which today is always the buyer organisation that placed the order, so
 *  `all-buyers` matches every row without needing a type check. */
const scopeSql = (scope: OrgScope, params: unknown[]): string => {
  if (scope.kind === 'single') {
    params.push(scope.orgId);
    return `org_id = $${params.length}`;
  }
  return 'TRUE';
};

/**
 * Read side of the audit projection. Not behind a port/interface like the ordering
 * repositories: `modules/audit` is a projection, not a domain with more than one
 * implementation to swap (see the module's own note on staying at three files).
 */
@Injectable()
export class SqlAuditRepository {
  async list(tx: Tx, scope: OrgScope, filter: AuditLogFilter, paging: Paging): Promise<AuditLogRow[]> {
    const params: unknown[] = [];
    const bind = paramBinder(params);
    const where = [scopeSql(scope, params)];
    if (filter.aggregateType) where.push(`aggregate_type = ${bind(filter.aggregateType)}`);
    if (filter.aggregateId) where.push(`aggregate_id = ${bind(filter.aggregateId)}`);
    if (filter.eventType) where.push(`event_type = ${bind(filter.eventType)}`);
    const page = pagingSql(paging, params);
    const rows = await tx.query<Row>(
      `SELECT id, event_id, aggregate_type, aggregate_id, event_type, org_id, actor_user_id, summary,
              occurred_at, recorded_at
         FROM audit_log
        WHERE ${where.join(' AND ')}
        ORDER BY occurred_at DESC, id DESC
        ${page}`,
      params,
    );
    return rows.map(toRow);
  }
}
