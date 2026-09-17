import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../platform/database/tx';
import { CatalogService } from '../../catalog/application/catalog.service';
import { CatalogErrors } from '../../catalog/domain/errors';
import { type OrgScope, assertOrgInScope } from '../../identity/domain/org-scope';
import type { OrgType } from '../../identity/domain/role';
import { type PriceLine, type PricedLine, PriceResolver } from '../application/ports/price-resolver';
import { PricingErrors } from '../domain/errors';
import { Money } from '../domain/money';
import { type PriceCandidate, pickPrice } from '../domain/pick-price';

interface CandidateRow {
  item_id: string;
  product_id: string;
  list_id: string;
  list_org_id: string | null;
  priority: number;
  valid_from: Date;
  valid_to: Date | null;
  status: 'active' | 'archived';
  min_qty: number;
  unit_price: string;
}

/**
 * Two queries per call, whatever the cart size: the products, then every tier that
 * could apply to them for this customer. The choice itself is `pickPrice`.
 */
@Injectable()
export class SqlPriceResolver extends PriceResolver {
  constructor(private readonly catalog: CatalogService) {
    super();
  }

  async resolve(
    db: Tx,
    scope: OrgScope,
    customer: { id: string; type: OrgType },
    lines: readonly PriceLine[],
    at: Date,
  ): Promise<PricedLine[]> {
    assertOrgInScope(scope, customer);
    for (const line of lines) {
      if (!Number.isSafeInteger(line.qty) || line.qty < 1) throw PricingErrors.invalidQuantity();
    }
    if (lines.length === 0) return [];

    // Ids are compared in application code below; Postgres returns them in lower case.
    const ids = lines.map((l) => l.productId.toLowerCase());
    const productIds = [...new Set(ids)];
    const products = await this.catalog.findProducts(db, productIds);
    for (const id of productIds) {
      const product = products.get(id);
      if (!product) throw CatalogErrors.productNotFound();
      if (!product.isActive) throw CatalogErrors.productInactive(product.sku);
    }

    // The SQL pre-filters on the customer and the validity window only to keep the
    // result small; pickPrice applies the full rule set again.
    const rows = await db.query<CandidateRow>(
      `SELECT i.id AS item_id, i.product_id, l.id AS list_id, l.org_id AS list_org_id,
              l.priority, l.valid_from, l.valid_to, l.status, i.min_qty, i.unit_price
         FROM price_list_items i
         JOIN price_lists l ON l.id = i.price_list_id
        WHERE i.product_id = ANY($1::uuid[])
          AND (l.org_id = $2 OR l.org_id IS NULL)
          AND l.status = 'active'
          AND l.valid_from <= $3
          AND (l.valid_to IS NULL OR l.valid_to > $3)`,
      [productIds, customer.id, at],
    );
    const byProduct = new Map<string, PriceCandidate[]>();
    for (const r of rows) {
      const list = byProduct.get(r.product_id) ?? [];
      list.push({
        itemId: r.item_id,
        listId: r.list_id,
        listOrgId: r.list_org_id,
        priority: r.priority,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        status: r.status,
        minQty: r.min_qty,
        unitPrice: Money.fromDb(r.unit_price),
      });
      byProduct.set(r.product_id, list);
    }

    return lines.map((line, i) => {
      const productId = ids[i]!;
      const product = products.get(productId)!;
      const price = pickPrice(byProduct.get(productId) ?? [], customer.id, line.qty, at, product.basePrice);
      return {
        ...price,
        productId,
        sku: product.sku,
        qty: line.qty,
        lineTotal: price.unitPrice.times(line.qty),
      };
    });
  }
}
