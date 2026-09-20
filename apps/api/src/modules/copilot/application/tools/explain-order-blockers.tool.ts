import { defineTool, toolFactory, type ToolFactory } from '@stockflow/ai-harness';
import { z } from 'zod';
import { OrderService } from '../../../ordering/application/order.service';
import type { ToolDeps } from './tool-deps';

const schema = z.object({
  orderCode: z.string().describe('Order code, e.g. "ORD-000123".'),
});

export function makeExplainOrderBlockersTool(orders: OrderService, deps: ToolDeps): ToolFactory {
  return toolFactory('explain_order_blockers', (ctx) =>
    defineTool({
      name: 'explain_order_blockers',
      description:
        'Why one order is not moving: what is holding it, which statuses it could go to next, ' +
        'and which lines stock could no longer cover.',
      schema,
      handler: ({ orderCode }) =>
        deps.read(ctx, async (db, { scope }) => {
          const report = await orders.diagnose(db, scope, orderCode);
          // A reservation stores a product id; people and the model speak SKUs.
          const skuOf = new Map(report.order.items.map((i) => [i.productId, i.sku]));
          return {
            orderCode: report.order.orderCode,
            status: report.order.status,
            // Structured, not prose: the model should relay facts, not re-derive them.
            blockers: report.blockers,
            nextStatuses: report.nextStatuses,
            heldReservations: report.reservations
              .filter((r) => r.status === 'held')
              .map((r) => ({
                sku: skuOf.get(r.productId) ?? r.productId,
                quantity: r.quantity,
                expiresAt: r.expiresAt?.toISOString() ?? null,
              })),
          };
        }),
    }),
  );
}
