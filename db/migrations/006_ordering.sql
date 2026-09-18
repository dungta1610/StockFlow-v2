-- Ordering: orders, their lines, the stock they hold, the outbox and idempotency keys
-- (schema `commerce`). Rebuilt from StockFlow/module/order/storage/*.go.
--
-- Deliberate differences from StockFlow:
-- * An order holds stock: every line has a reservation, and cancelling, expiring or
--   fulfilling moves that stock. StockFlow only inserted the order and changed status.
-- * Money is numeric, never float; prices come from the price resolver, not the client.
-- * order_code comes from a sequence. StockFlow drew 6 random digits and relied on
--   UNIQUE, so a collision failed the transaction sooner or later.
-- * Reservations are held / released / consumed. There is no intermediate state a
--   crashed worker could leave behind.

CREATE SEQUENCE order_code_seq;

-- ORD-<local date>-<sequence>. The sequence is global, so codes never collide whatever
-- the date; the date is only there for people. Padding widens instead of truncating
-- once the counter passes 999999. The sequence is schema-qualified so the function
-- works whatever the caller's search_path.
CREATE FUNCTION next_order_code() RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT 'ORD-' || to_char(now() AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYYMMDD') || '-'
         || lpad(s::text, greatest(6, length(s::text)), '0')
    FROM nextval('commerce.order_code_seq') AS s
$$;

CREATE TABLE orders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code             text NOT NULL UNIQUE DEFAULT next_order_code(),
  buyer_org_id           uuid NOT NULL,
  -- Copied through the composite key below, so an order can only ever belong to a
  -- buyer organisation, and OrgScope filters without joining organizations.
  buyer_org_type         text NOT NULL DEFAULT 'buyer' CHECK (buyer_org_type = 'buyer'),
  placed_by_user_id      uuid NOT NULL REFERENCES users (id),
  warehouse_id           uuid NOT NULL REFERENCES warehouses (id),
  -- All eight StockFlow statuses are accepted; v1 only ever produces reserved, paid,
  -- fulfilled, cancelled and expired (see order-state-machine.ts).
  status                 text NOT NULL CHECK (status IN (
    'pending', 'reserved', 'awaiting_payment', 'paid', 'fulfilled', 'completed', 'cancelled', 'expired'
  )),
  subtotal               numeric(18, 2) NOT NULL CHECK (subtotal >= 0),
  total                  numeric(18, 2) NOT NULL CHECK (total >= 0),
  currency               char(3) NOT NULL DEFAULT 'VND' CHECK (currency = 'VND'),
  reservation_expires_at timestamptz,
  paid_at                timestamptz,
  cancelled_at           timestamptz,
  expired_at             timestamptz,
  fulfilled_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (buyer_org_id, buyer_org_type) REFERENCES organizations (id, type)
);
CREATE INDEX idx_orders_buyer_created ON orders (buyer_org_id, created_at DESC, id DESC);
CREATE INDEX idx_orders_created ON orders (created_at DESC, id DESC);
-- The expiry sweep: only orders still holding stock.
CREATE INDEX idx_orders_reserved_expiry ON orders (reservation_expires_at) WHERE status = 'reserved';

CREATE TABLE order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES products (id),
  quantity           int NOT NULL CHECK (quantity > 0),
  unit_price         numeric(18, 2) NOT NULL CHECK (unit_price >= 0),
  line_total         numeric(18, 2) NOT NULL CHECK (line_total >= 0),
  -- Which price-list tier priced the line; NULL when the product's base price applied.
  price_list_item_id uuid REFERENCES price_list_items (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id)
);

CREATE TABLE inventory_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders (id),
  order_item_id uuid NOT NULL UNIQUE REFERENCES order_items (id),
  inventory_id  uuid NOT NULL REFERENCES inventory (id),
  product_id    uuid NOT NULL REFERENCES products (id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses (id),
  quantity      int NOT NULL CHECK (quantity > 0),
  status        text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'consumed')),
  expires_at    timestamptz,
  reserved_at   timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reservations_order ON inventory_reservations (order_id, status);
CREATE INDEX idx_reservations_held_expiry ON inventory_reservations (expires_at) WHERE status = 'held';

-- Written in the same transaction as the change it describes. `status` is the only
-- "has it been handled" predicate; processed_at is just a timestamp.
CREATE TABLE outbox_events (
  id              bigserial PRIMARY KEY,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  -- Every event belongs to an organisation, so projections never produce rows that
  -- no tenant owns.
  org_id          uuid NOT NULL REFERENCES organizations (id),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'dead')),
  -- Failed attempts, not claims.
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error      text,
  processed_at    timestamptz
);
CREATE INDEX idx_outbox_pending ON outbox_events (status, next_attempt_at, id) WHERE status = 'pending';

-- A key is claimed in its own committed statement before the work starts, so a
-- concurrent duplicate sees it at once. Only success locks a key: a failed attempt
-- marks it `failed` and the next request with that key may claim it again.
CREATE TABLE idempotency_keys (
  org_id            uuid NOT NULL REFERENCES organizations (id),
  endpoint          text NOT NULL,
  key               text NOT NULL,
  request_hash      text NOT NULL,
  status            text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
  response_status   int,
  response_snapshot jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, endpoint, key),
  CHECK (status <> 'completed' OR (response_status IS NOT NULL AND response_snapshot IS NOT NULL))
);

-- The ledger columns created in 005 now get their foreign keys. The reservation key is
-- checked at commit: a reserve movement and its ledger row are written in one step,
-- before the reservation row that records it exists.
ALTER TABLE inventory_transactions
  ADD CONSTRAINT fk_itx_order FOREIGN KEY (order_id) REFERENCES orders (id),
  ADD CONSTRAINT fk_itx_reservation FOREIGN KEY (reservation_id) REFERENCES inventory_reservations (id)
    DEFERRABLE INITIALLY DEFERRED;
