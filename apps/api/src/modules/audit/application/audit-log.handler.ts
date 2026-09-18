import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import type { OutboxEvent, OutboxHandler } from '../../../platform/outbox/outbox-handler.interface';
import { SYSTEM_ACTOR_ID } from '../../identity/domain/actor';

/**
 * Fields kept in `audit_log.summary` for one event type, and how to find its
 * (optional) human actor — an explicit whitelist, never the raw outbox payload
 * (docs/adr/0019). `order.created` carries `unit_price` and `price_list_item_id`,
 * the most sensitive figures in this system, and audit is read by more roles than
 * see contract pricing, so those fields are named here only to be left out.
 */
interface EventProjection {
  summary(payload: Record<string, unknown>): Record<string, unknown>;
  actorUserId(payload: Record<string, unknown>): string | null;
}

/** `payload.actor_user_id` is the sweep's `systemActor` for a system-driven
 *  transition — not a row in `users` — so it is stored as no actor, not a dangling id. */
const humanActorFrom = (field: string) => (payload: Record<string, unknown>): string | null => {
  const id = payload[field];
  return typeof id === 'string' && id !== SYSTEM_ACTOR_ID ? id : null;
};

const orderCreated: EventProjection = {
  summary: (p) => ({
    order_id: p.order_id,
    order_code: p.order_code,
    buyer_org_id: p.buyer_org_id,
    placed_by_user_id: p.placed_by_user_id,
    warehouse_id: p.warehouse_id,
    // No `total` (or any other derived money): the phase's keep-list is status,
    // timestamps and quantities. With per-line quantity already kept, a total
    // would make unit_price recoverable by division on any single-line order —
    // exactly the derivation the redaction exists to prevent (docs/adr/0019).
    currency: p.currency,
    reservation_expires_at: p.reservation_expires_at,
    items: Array.isArray(p.items)
      ? (p.items as Record<string, unknown>[]).map((i) => ({
          product_id: i.product_id,
          sku: i.sku,
          quantity: i.quantity,
        }))
      : [],
  }),
  actorUserId: humanActorFrom('placed_by_user_id'),
};

const orderTransition: EventProjection = {
  summary: (p) => ({
    order_id: p.order_id,
    order_code: p.order_code,
    buyer_org_id: p.buyer_org_id,
    from: p.from,
    to: p.to,
  }),
  actorUserId: humanActorFrom('actor_user_id'),
};

const PROJECTIONS: Record<string, EventProjection> = {
  'order.created': orderCreated,
  'order.paid': orderTransition,
  'order.fulfilled': orderTransition,
  'order.cancelled': orderTransition,
  'order.expired': orderTransition,
};

/**
 * The audit projection: one row per outbox event it recognises, filtered to a
 * whitelist of fields. `event_id UNIQUE` + `ON CONFLICT DO NOTHING` is what makes
 * this safe to run twice for the same event — the pattern every later consumer of
 * the outbox should copy (docs/code-standards.md).
 */
@Injectable()
export class AuditLogHandler implements OutboxHandler {
  readonly eventTypes = Object.keys(PROJECTIONS);

  async handle(tx: Tx, event: OutboxEvent): Promise<void> {
    const projection = PROJECTIONS[event.eventType];
    if (!projection) return; // the relay only ever routes the event types above here
    await tx.query(
      `INSERT INTO audit_log
         (event_id, aggregate_type, aggregate_id, event_type, org_id, actor_user_id, summary, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.id,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        event.orgId,
        projection.actorUserId(event.payload),
        JSON.stringify(projection.summary(event.payload)),
        event.occurredAt,
      ],
    );
  }
}
