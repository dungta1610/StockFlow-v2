import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import { type NewOutboxEvent, OutboxRepository } from '../application/ports/outbox.repository';

@Injectable()
export class SqlOutboxRepository extends OutboxRepository {
  async append(tx: Tx, event: NewOutboxEvent): Promise<void> {
    await tx.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, org_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [event.aggregateType, event.aggregateId, event.eventType, event.orgId, JSON.stringify(event.payload)],
    );
  }
}
