-- Pricing: default and per-customer price lists with quantity tiers (schema
-- `commerce`). StockFlow had no pricing; clients sent unit prices themselves.

CREATE TABLE price_lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = the default list that applies to every buyer.
  org_id     uuid,
  -- Copied from the organisation through the composite key below, so a contract
  -- list can only ever belong to a *buyer* organisation.
  org_type   text,
  name       text NOT NULL,
  currency   char(3) NOT NULL DEFAULT 'VND' CHECK (currency = 'VND'),
  valid_from timestamptz NOT NULL,
  valid_to   timestamptz,
  -- Higher wins when several lists of the same kind apply.
  priority   int NOT NULL DEFAULT 0,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, org_type) REFERENCES organizations (id, type) ON UPDATE CASCADE,
  CONSTRAINT chk_price_list_owner CHECK (
    (org_id IS NULL AND org_type IS NULL) OR (org_id IS NOT NULL AND org_type = 'buyer')
  ),
  CONSTRAINT chk_price_list_validity CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX idx_price_lists_org ON price_lists (org_id, status, valid_from DESC);

-- A quantity tier: this unit price applies from min_qty upwards.
CREATE TABLE price_list_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id uuid NOT NULL REFERENCES price_lists (id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products (id),
  min_qty       int NOT NULL DEFAULT 1 CHECK (min_qty >= 1),
  unit_price    numeric(18, 2) NOT NULL CHECK (unit_price >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (price_list_id, product_id, min_qty)
);
CREATE INDEX idx_price_list_items_product ON price_list_items (product_id, price_list_id);
