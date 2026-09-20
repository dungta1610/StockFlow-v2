import { defineTool, toolFactory, type ToolFactory } from '@stockflow/ai-harness';
import { z } from 'zod';
import { OrderService } from '../../../ordering/application/order.service';
import { ORDER_STATUSES } from '../../../ordering/domain/order-state-machine';
import type { ToolDeps } from './tool-deps';

const MAX_ROWS = 20;

/**
 * No organisation field, on purpose. Which buyers' orders come back is decided by
 * the caller's `OrgScope`: an operator sees every buyer, a buyer sees only their
 * own, and neither outcome is anything the model chose.
 */
const schema = z.object({
  status: z.enum(ORDER_STATUSES).optional().describe('Restrict to one order status.'),
  orderCode: z.string().optional().describe('Exact order code, e.g. "ORD-000123".'),
  expiresWithinMinutes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Only orders whose stock hold ends within this many minutes.'),
});

export function makeFindOrdersTool(orders: OrderService, deps: ToolDeps): ToolFactory {
  return toolFactory('find_orders', (ctx) =>
    defineTool({
      name: 'find_orders',
      description: 'Find orders by status, code, or how soon their stock hold expires. Newest first.',
      schema,
      handler: (input) =>
        deps.read(ctx, async (db, { scope }) => {
          const found = await orders.list(db, scope, input, { page: 1, limit: MAX_ROWS });
          return found.map((o) => ({
            orderCode: o.orderCode,
            status: o.status,
            buyerOrgId: o.buyerOrgId,
            total: o.total.toString(),
            reservationExpiresAt: o.reservationExpiresAt?.toISOString() ?? null,
            items: o.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
          }));
        }),
    }),
  );
}
