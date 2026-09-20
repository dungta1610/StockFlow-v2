import { defineTool, toolFactory, type ToolFactory } from '@stockflow/ai-harness';
import { z } from 'zod';
import { ReservationService } from '../../../ordering/application/reservation.service';
import type { ToolDeps } from './tool-deps';

const schema = z.object({
  withinMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .describe('How far ahead to look. Holds already overdue are included.'),
});

export function makeListExpiringReservationsTool(reservations: ReservationService, deps: ToolDeps): ToolFactory {
  return toolFactory('list_expiring_reservations', (ctx) =>
    defineTool({
      name: 'list_expiring_reservations',
      description:
        'Stock holds on unpaid orders that end within a given number of minutes, soonest first. ' +
        'Overdue holds are included.',
      schema,
      handler: ({ withinMinutes }) =>
        deps.read(ctx, async (db, { scope }) => {
          const rows = await reservations.listExpiring(db, scope, withinMinutes);
          return rows.map((r) => ({
            orderCode: r.orderCode,
            sku: r.sku,
            quantity: r.quantity,
            expiresAt: r.expiresAt?.toISOString() ?? null,
          }));
        }),
    }),
  );
}
