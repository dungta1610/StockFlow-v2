import type { Tx } from '../database/tx';

/** One claimed row of `outbox_events`, shaped for a handler (docs/adr/0017). */
export interface OutboxEvent {
  id: number;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  orgId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  /** Failed dispatch attempts so far. A claim never increments this. */
  attempts: number;
}

/**
 * A consumer of one or more outbox event types. `handle` runs inside the same
 * transaction the relay uses to mark the event processed, so a handler's writes and
 * "this event is done" always commit together or not at all.
 *
 * **Must be idempotent.** At-least-once delivery means the same event can reach
 * `handle` more than once: a retry after the relay's own "mark processed" step
 * failed, or an operator re-running a dead event. The pattern this codebase uses is
 * a unique key on whatever the handler writes plus `ON CONFLICT ... DO NOTHING`
 * (see `AuditLogHandler`) — see docs/code-standards.md.
 */
export interface OutboxHandler {
  readonly eventTypes: string[];
  handle(tx: Tx, event: OutboxEvent): Promise<void>;
}
