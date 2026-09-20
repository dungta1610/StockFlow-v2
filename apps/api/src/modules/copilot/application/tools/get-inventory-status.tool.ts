import { defineTool, toolFactory, type ToolFactory } from '@stockflow/ai-harness';
import { z } from 'zod';
import { InventoryService } from '../../../inventory/application/inventory.service';
import type { ToolDeps } from './tool-deps';

/**
 * Note what the schema does not have: any way to name an organisation. A model
 * cannot ask about a tenant it was not already acting for, because there is no
 * field to put one in. That is the pattern every read tool here follows.
 */
const schema = z.object({
  sku: z.string().describe('Product SKU, as printed on documents.'),
  warehouseCode: z.string().optional().describe('Warehouse code. Omit for every warehouse.'),
});

export function makeGetInventoryStatusTool(inventory: InventoryService, deps: ToolDeps): ToolFactory {
  return toolFactory('get_inventory_status', (ctx) =>
    defineTool({
      name: 'get_inventory_status',
      description:
        'Current stock for one SKU: available and reserved quantities, in one warehouse or across all of them.',
      schema,
      handler: (input) => deps.read(ctx, (db, { actor }) => inventory.getStatus(db, actor, input)),
    }),
  );
}
