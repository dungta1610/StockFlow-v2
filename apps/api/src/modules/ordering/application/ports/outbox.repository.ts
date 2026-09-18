import type { OutboxEventStatus } from '@stockflow/contracts';
import type { Paging } from '../../../../platform/database/sql';
import type { Tx } from '../../../../platform/database/tx';
import type { OrgScope } from '../../../identity/domain/org-scope';

export interface NewOutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  /** The organisation the event belongs to; never null. */
  orgId: string;
  payload: Record<string, unknown>;
}

export interface OutboxEventRecord {
  id: number;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  orgId: string;
  status: OutboxEventStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  occurredAt: Date;
  processedAt: Date | null;
}

/**
 * Records that something happened, in the transaction that made it happen: the event
 * exists exactly when the change committed. Delivery is someone else's job (the
 * outbox relay, `platform/outbox`).
 */
export abstract class OutboxRepository {
  abstract append(tx: Tx, event: NewOutboxEvent): Promise<void>;

  /** For `GET /ops/outbox`: the queue an operator watches for stuck or dead events. */
  abstract listByStatus(
    tx: Tx,
    scope: OrgScope,
    status: OutboxEventStatus | undefined,
    paging: Paging,
  ): Promise<OutboxEventRecord[]>;
}
