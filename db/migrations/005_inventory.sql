-- Inventory and its ledger (schema `commerce`). Columns rebuilt from
-- StockFlow/module/inventory/storage/*.go; the CHECK constraints and the atomic
-- write paths are new (the Go version could race a row into existence twice).

CREATE TABLE inventory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES products (id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses (id),
  available_qty int NOT NULL DEFAULT 0,
  reserved_qty  int NOT NULL DEFAULT 0,
  -- Audit only. v1 does not use it as an optimistic lock (see ADR 0012).
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, warehouse_id),
  -- Last line of defence: the write paths already prevent negatives.
  CONSTRAINT chk_inventory_available_non_negative CHECK (available_qty >= 0),
  CONSTRAINT chk_inventory_reserved_non_negative CHECK (reserved_qty >= 0)
);

-- Append-only: every change to `inventory` writes one row here in the same
-- transaction, carrying the levels before and after.
CREATE TABLE inventory_transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id         uuid NOT NULL REFERENCES inventory (id),
  product_id           uuid NOT NULL REFERENCES products (id),
  warehouse_id         uuid NOT NULL REFERENCES warehouses (id),
  -- Orders and reservations arrive in phase 04; the foreign keys are added there
  -- so this migration does not depend on tables that do not exist yet.
  order_id             uuid,
  reservation_id       uuid,
  txn_type             text NOT NULL CHECK (
    txn_type IN ('manual_adjustment', 'reserve', 'release', 'consume')
  ),
  quantity             int NOT NULL CHECK (quantity > 0),
  before_available_qty int NOT NULL,
  after_available_qty  int NOT NULL,
  before_reserved_qty  int NOT NULL,
  after_reserved_qty   int NOT NULL,
  reason               text NOT NULL DEFAULT '',
  created_by           uuid REFERENCES users (id),
  -- clock_timestamp(), not now(): several movements in one transaction must be
  -- orderable, and now() would give them all the transaction's start time.
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_inventory_transactions_inventory ON inventory_transactions (inventory_id, created_at DESC);
CREATE INDEX idx_inventory_transactions_order ON inventory_transactions (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_inventory_transactions_product ON inventory_transactions (product_id, created_at DESC);
CREATE INDEX idx_inventory_transactions_warehouse ON inventory_transactions (warehouse_id, created_at DESC);
CREATE INDEX idx_inventory_transactions_reservation ON inventory_transactions (reservation_id) WHERE reservation_id IS NOT NULL;
-- product_id leads the unique index, so only warehouse-first lookups need their own.
CREATE INDEX idx_inventory_warehouse ON inventory (warehouse_id);
