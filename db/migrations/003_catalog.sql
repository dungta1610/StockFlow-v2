-- Catalog: products and warehouses (schema `commerce`), ported from StockFlow's
-- module/product and module/warehouse storage.
--
-- Differences from StockFlow: money is numeric, not float; the list price is named
-- base_price because buyers are charged their contract price; v1 has one currency.

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  base_price  numeric(18, 2) NOT NULL CHECK (base_price >= 0),
  -- One currency in v1. Widening this is a migration, not a code change scattered
  -- across the app.
  currency    char(3) NOT NULL DEFAULT 'VND' CHECK (currency = 'VND'),
  uom         text NOT NULL DEFAULT 'each',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (sku = upper(btrim(sku)) AND sku <> '')
);
CREATE INDEX idx_products_created ON products (created_at DESC, id DESC);

CREATE TABLE warehouses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  address    text NOT NULL DEFAULT '',
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (code = upper(btrim(code)) AND code <> '')
);
CREATE INDEX idx_warehouses_created ON warehouses (created_at DESC, id DESC);
