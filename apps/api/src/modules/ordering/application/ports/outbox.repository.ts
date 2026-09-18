import type { Tx } from '../../../../platform/database/tx';

export interface NewOutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  /** The organisation the event belongs to; never null. */
  orgId: string;
  payload: Record<string, unknown>;
}

/**
 * Records that something happened, in the transaction that made it happen: the event
 * exists exactly when the change committed. Delivery is someone else's job.
 */
export abstract class OutboxRepository {
  abstract append(tx: Tx, event: NewOutboxEvent): Promise<void>;
}
