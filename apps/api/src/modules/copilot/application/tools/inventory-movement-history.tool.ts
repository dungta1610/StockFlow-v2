import { defineTool, toolFactory, type ToolFactory } from '@stockflow/ai-harness';
import { z } from 'zod';
import { LedgerService } from '../../../inventory/application/ledger.service';
import { TXN_TYPES } from '../../../inventory/domain/inventory-transaction';
import type { ToolDeps } from './tool-deps';

/** Enough history to explain a discrepancy, not enough to fill a context window. */
const MAX_ROWS = 20;

const schema = z.object({
  sku: z.string().describe('Product SKU.'),
  warehouseCode: z.string().optional().describe('Warehouse code. Omit for every warehouse.'),
  txnType: z.enum(TXN_TYPES).optional().describe('Restrict to one kind of movement.'),
});

export function makeInventoryMovementHistoryTool(ledger: LedgerService, deps: ToolDeps): ToolFactory {
  return toolFactory('inventory_movement_history', (ctx) =>
    defineTool({
      name: 'inventory_movement_history',
      description: 'Recent stock movements for one SKU, newest first — what moved, when, why and by how much.',
      schema,
      handler: (input) =>
        deps.read(ctx, (db, { actor }) => ledger.history(db, actor, input, { page: 1, limit: MAX_ROWS })),
    }),
  );
}
