import { Injectable } from '@nestjs/common';
import { type Paging, pagingSql, paramBinder } from '../../../platform/database/sql';
import type { Tx } from '../../../platform/database/tx';
import type { OrgScope } from '../../identity/domain/org-scope';
import { scopeSql } from '../../identity/infrastructure/scope-sql';
import { PriceListRepository } from '../application/ports/price-list.repository';
import { Money } from '../domain/money';
import type { PriceList, PriceListFilter, PriceListItem, PriceListStatus } from '../domain/price-list';

interface PriceListRow {
  id: string;
  org_id: string | null;
  name: string;
  currency: string;
  valid_from: Date;
  valid_to: Date | null;
  priority: number;
  status: PriceListStatus;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  id: string;
  product_id: string;
  sku: string;
  min_qty: number;
  unit_price: string;
}

const COLUMNS = 'id, org_id, name, currency, valid_from, valid_to, priority, status, created_at, updated_at';

/** Default lists (no owner) are visible in every scope; contract lists follow the scope. */
const inScope = (scope: OrgScope, params: unknown[]): string =>
  `(org_id IS NULL OR ${scopeSql(scope, { id: 'org_id', type: 'org_type' }, params)})`;

const toPriceList = (r: PriceListRow): PriceList => ({
  id: r.id,
  orgId: r.org_id,
  name: r.name,
  currency: r.currency,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  priority: r.priority,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

@Injectable()
export class SqlPriceListRepository extends PriceListRepository {
  async create(
    tx: Tx,
    data: { orgId: string | null; name: string; validFrom: Date; validTo: Date | null; priority: number },
  ): Promise<PriceList> {
    // org_type is always 'buyer' for a contract list; the composite foreign key
    // then rejects any organisation that is not actually a buyer.
    const [row] = await tx.query<PriceListRow>(
      `INSERT INTO price_lists (org_id, org_type, name, valid_from, valid_to, priority)
       VALUES ($1, CASE WHEN $1::uuid IS NULL THEN NULL ELSE 'buyer' END, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [data.orgId, data.name, data.validFrom, data.validTo, data.priority],
    );
    return toPriceList(row!);
  }

  async findById(
    tx: Tx,
    scope: OrgScope,
    id: string,
    opts?: { forUpdate?: boolean },
  ): Promise<PriceList | null> {
    const params: unknown[] = [id];
    const [row] = await tx.query<PriceListRow>(
      `SELECT ${COLUMNS} FROM price_lists
        WHERE id = $1 AND ${inScope(scope, params)}${opts?.forUpdate ? ' FOR UPDATE' : ''}`,
      params,
    );
    return row ? toPriceList(row) : null;
  }

  async findItems(tx: Tx, priceListId: string): Promise<PriceListItem[]> {
    const rows = await tx.query<ItemRow>(
      `SELECT i.id, i.product_id, p.sku, i.min_qty, i.unit_price
         FROM price_list_items i
         JOIN products p ON p.id = i.product_id
        WHERE i.price_list_id = $1
        ORDER BY p.sku, i.min_qty`,
      [priceListId],
    );
    return rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      sku: r.sku,
      minQty: r.min_qty,
      unitPrice: Money.fromDb(r.unit_price),
    }));
  }

  async list(tx: Tx, scope: OrgScope, filter: PriceListFilter, paging: Paging): Promise<PriceList[]> {
    const params: unknown[] = [];
    const bind = paramBinder(params);
    const where = [inScope(scope, params)];
    if (filter.orgId) where.push(`org_id = ${bind(filter.orgId)}`);
    if (filter.status) where.push(`status = ${bind(filter.status)}`);
    const rows = await tx.query<PriceListRow>(
      `SELECT ${COLUMNS} FROM price_lists
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        ${pagingSql(paging, params)}`,
      params,
    );
    return rows.map(toPriceList);
  }

  async upsertItems(
    tx: Tx,
    priceListId: string,
    items: readonly { productId: string; minQty: number; unitPrice: Money }[],
  ): Promise<void> {
    await tx.query(
      `INSERT INTO price_list_items (price_list_id, product_id, min_qty, unit_price)
       SELECT $1, t.product_id, t.min_qty, t.unit_price
         FROM unnest($2::uuid[], $3::int[], $4::numeric[]) AS t(product_id, min_qty, unit_price)
       ON CONFLICT (price_list_id, product_id, min_qty)
       DO UPDATE SET unit_price = EXCLUDED.unit_price, updated_at = now()`,
      [
        priceListId,
        items.map((i) => i.productId),
        items.map((i) => i.minQty),
        items.map((i) => i.unitPrice.toString()),
      ],
    );
    await tx.query(`UPDATE price_lists SET updated_at = now() WHERE id = $1`, [priceListId]);
  }

  async archive(tx: Tx, scope: OrgScope, id: string): Promise<PriceList | null> {
    const params: unknown[] = [id];
    const [row] = await tx.query<PriceListRow>(
      `UPDATE price_lists
          SET status = 'archived',
              updated_at = CASE WHEN status = 'archived' THEN updated_at ELSE now() END
        WHERE id = $1 AND ${inScope(scope, params)}
        RETURNING ${COLUMNS}`,
      params,
    );
    return row ? toPriceList(row) : null;
  }
}
