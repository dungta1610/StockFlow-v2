-- Audit projection: a durable, filtered read model built from outbox_events by the
-- outbox relay's audit consumer (schema `commerce`). outbox_events (migration 006)
-- stays the single source of truth for "did this happen"; audit_log is a read model
-- for "what can a person see about it" and is rebuildable by replaying the outbox.
--
-- Deliberately different from a raw event log:
-- * org_id is NOT NULL — a projection that cannot be traced to a tenant is refused,
--   never stored with a null owner.
-- * summary is a per-event-type whitelist the handler builds, never the outbox
--   event's raw payload: order.created carries unit_price and price_list_item_id,
--   the most sensitive figures in this system, and audit is read by more roles
--   than see contract pricing.
-- * event_id is UNIQUE and referenced back to outbox_events, so the handler's
--   ON CONFLICT (event_id) DO NOTHING is what makes it safe to run twice.
--
-- Also adds an index on idempotency_keys.updated_at for the key cleanup job.

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  -- The outbox event this row projects; also the consumer's idempotency key.
  event_id       bigint NOT NULL UNIQUE REFERENCES outbox_events (id),
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  org_id         uuid NOT NULL REFERENCES organizations (id),
  -- Null for events with no human behind them (the reservation-expiry sweep runs as
  -- systemActor, which is not a row in `users`).
  actor_user_id  uuid REFERENCES users (id),
  summary        jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_aggregate ON audit_log (aggregate_type, aggregate_id, occurred_at DESC);
CREATE INDEX idx_audit_org ON audit_log (org_id, occurred_at DESC);

-- Supports the idempotency-key cleanup job's DELETE ... WHERE updated_at < $ttl
-- (modules/ordering/infrastructure/sql-idempotency.repository.ts): without it,
-- the hourly cleanup is a sequential scan of the whole table.
CREATE INDEX idx_idempotency_keys_updated_at ON idempotency_keys (updated_at);
