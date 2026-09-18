import type { OrderItemView, OrderView } from '@stockflow/contracts';
import type { OrderItem, OrderWithItems } from '../domain/order';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const presentItem = (i: OrderItem): OrderItemView => ({
  id: i.id,
  product_id: i.productId,
  sku: i.sku,
  quantity: i.quantity,
  unit_price: i.unitPrice.toString(),
  line_total: i.lineTotal.toString(),
  price_list_item_id: i.priceListItemId,
});

export const presentOrder = (o: OrderWithItems): OrderView => ({
  id: o.id,
  order_code: o.orderCode,
  buyer_org_id: o.buyerOrgId,
  placed_by_user_id: o.placedByUserId,
  warehouse_id: o.warehouseId,
  status: o.status,
  subtotal: o.subtotal.toString(),
  total: o.total.toString(),
  currency: o.currency,
  reservation_expires_at: iso(o.reservationExpiresAt),
  paid_at: iso(o.paidAt),
  cancelled_at: iso(o.cancelledAt),
  expired_at: iso(o.expiredAt),
  fulfilled_at: iso(o.fulfilledAt),
  created_at: o.createdAt.toISOString(),
  updated_at: o.updatedAt.toISOString(),
  items: o.items.map(presentItem),
});
