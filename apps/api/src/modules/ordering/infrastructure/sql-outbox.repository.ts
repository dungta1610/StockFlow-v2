import { Injectable } from '@nestjs/common';
import type { OutboxEventStatus } from '@stockflow/contracts';
import { type Paging, pagingSql, paramBinder } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import type { OrgScope } from '../../identity/domain/org-scope';
import { type NewOutboxEvent, type OutboxEventRecord, OutboxRepository } from '../application/ports/outbox.repository';

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  org_id: string;
  status: OutboxEventStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | null;
  occurred_at: Date;
  processed_at: Date | null;
}

const toRecord = (r: OutboxRow): OutboxEventRecord => ({
  id: Number(r.id),
  aggregateType: r.aggregate_type,
  aggregateId: r.aggregate_id,
  eventType: r.event_type,
  orgId: r.org_id,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  nextAttemptAt: r.next_attempt_at,
  occurredAt: r.occurred_at,
  processedAt: r.processed_at,
});

/** outbox_events has no org_type column: every event today comes from ordering,
 *  whose org_id is always a buyer organisation, so `all-buyers` matches every row. */
const outboxScopeSql = (scope: OrgScope, params: unknown[]): string => {
  if (scope.kind === 'single') {
    params.push(scope.orgId);
    return `org_id = $${params.length}`;
  }
  return 'TRUE';
};

@Injectable()
export class SqlOutboxRepository extends OutboxRepository {
  async append(tx: Tx, event: NewOutboxEvent): Promise<void> {
    await tx.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, org_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.aggregateType, event.aggregateId, event.eventType, event.orgId, JSON.stringify(event.payload)],
    );
  }

  async listByStatus(
    tx: Tx,
    scope: OrgScope,
    status: OutboxEventStatus | undefined,
    paging: Paging,
  ): Promise<OutboxEventRecord[]> {
    const params: unknown[] = [];
    const bind = paramBinder(params);
    const where = [outboxScopeSql(scope, params)];
    if (status) where.push(`status = ${bind(status)}`);
    const page = pagingSql(paging, params);
    const rows = await tx.query<OutboxRow>(
      `SELECT id, aggregate_type, aggregate_id, event_type, org_id, status, attempts, last_error,
              next_attempt_at, occurred_at, processed_at
         FROM outbox_events
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
        ${page}`,
      params,
    );
    return rows.map(toRecord);
  }
}
