import type { Client } from 'pg';

export async function insertProduct(
  pg: Client,
  p: { sku: string; basePrice: string; name?: string; isActive?: boolean },
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO commerce.products (sku, name, base_price, is_active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [p.sku, p.name ?? p.sku, p.basePrice, p.isActive ?? true],
  );
  return rows[0]!.id;
}

export async function insertWarehouse(
  pg: Client,
  w: { code: string; name?: string; isActive?: boolean },
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO commerce.warehouses (code, name, is_active) VALUES ($1, $2, $3) RETURNING id`,
    [w.code, w.name ?? w.code, w.isActive ?? true],
  );
  return rows[0]!.id;
}

export async function insertPriceList(
  pg: Client,
  l: {
    orgId?: string | null;
    name?: string;
    priority?: number;
    validFrom?: string;
    validTo?: string | null;
    status?: 'active' | 'archived';
  },
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO commerce.price_lists (org_id, org_type, name, priority, valid_from, valid_to, status)
     VALUES ($1, CASE WHEN $1::uuid IS NULL THEN NULL ELSE 'buyer' END, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      l.orgId ?? null,
      l.name ?? 'list',
      l.priority ?? 0,
      l.validFrom ?? '2020-01-01T00:00:00Z',
      l.validTo ?? null,
      l.status ?? 'active',
    ],
  );
  return rows[0]!.id;
}

export async function insertTier(
  pg: Client,
  t: { listId: string; productId: string; unitPrice: string; minQty?: number },
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO commerce.price_list_items (price_list_id, product_id, min_qty, unit_price)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [t.listId, t.productId, t.minQty ?? 1, t.unitPrice],
  );
  return rows[0]!.id;
}
