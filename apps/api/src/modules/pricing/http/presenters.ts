import type { PriceListItemView, PriceListView, QuoteLineView, QuoteView } from '@stockflow/contracts';
import type { PricedLine } from '../application/ports/price-resolver';
import type { Quote } from '../application/use-cases/quote-prices.use-case';
import type { PriceList, PriceListItem } from '../domain/price-list';

const presentItem = (i: PriceListItem): PriceListItemView => ({
  id: i.id,
  product_id: i.productId,
  sku: i.sku,
  min_qty: i.minQty,
  unit_price: i.unitPrice.toString(),
});

export const presentPriceList = (l: PriceList & { items?: PriceListItem[] }): PriceListView => ({
  id: l.id,
  org_id: l.orgId,
  name: l.name,
  currency: l.currency,
  valid_from: l.validFrom.toISOString(),
  valid_to: l.validTo?.toISOString() ?? null,
  priority: l.priority,
  status: l.status,
  created_at: l.createdAt.toISOString(),
  updated_at: l.updatedAt.toISOString(),
  ...(l.items && { items: l.items.map(presentItem) }),
});

const presentLine = (l: PricedLine): QuoteLineView => ({
  product_id: l.productId,
  sku: l.sku,
  qty: l.qty,
  unit_price: l.unitPrice.toString(),
  line_total: l.lineTotal.toString(),
  source_kind: l.sourceKind,
  source_id: l.sourceId,
  price_list_id: l.priceListId,
  min_qty_applied: l.minQtyApplied,
});

export const presentQuote = (q: Quote): QuoteView => ({
  customer_org_id: q.customerOrgId,
  // Single-currency system (see ADR 0010).
  currency: 'VND',
  priced_at: q.pricedAt.toISOString(),
  lines: q.lines.map(presentLine),
  total: q.total.toString(),
});
