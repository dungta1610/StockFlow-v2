import { defineTool, toolFactory, type ToolFactory } from '@stockflow/ai-harness';
import { z } from 'zod';
import { ProposalService } from '../proposal.service';
import type { ToolDeps } from './tool-deps';

/**
 * The agent's only write, and it writes no stock.
 *
 * It records a suggestion for a person to approve or reject. Letting an agent move
 * stock directly would be a poor trade: it would put the invariants the inventory
 * and ordering work exists to protect behind a model's judgement, in exchange for
 * saving one click. Approval keeps the value — the hard part is noticing and
 * explaining — without the risk (docs/adr/0024).
 */
const schema = z.object({
  sku: z.string().describe('Product SKU to adjust.'),
  warehouseCode: z.string().describe('Warehouse holding the stock.'),
  deltaQty: z
    .number()
    .int()
    .refine((n) => n !== 0, 'must not be zero')
    .describe('Signed change: positive adds stock, negative removes it.'),
  reason: z.string().min(3).max(200).describe('Short reason, as it will appear in the ledger.'),
  rationale: z.string().max(2_000).optional().describe('Why you believe this is correct, for the reviewer.'),
});

export function makeProposeStockAdjustmentTool(proposals: ProposalService, deps: ToolDeps): ToolFactory {
  return toolFactory('propose_stock_adjustment', (ctx) =>
    defineTool({
      name: 'propose_stock_adjustment',
      description:
        'Propose a stock correction for a person to approve. This does NOT change stock — it creates a ' +
        'pending proposal. Say so when you use it.',
      schema,
      handler: (input) =>
        deps.write(ctx, async (tx, { actor }) => {
          const proposal = await proposals.create(tx, actor, input, ctx.sessionId);
          return {
            proposalId: proposal.id,
            status: proposal.status,
            sku: proposal.sku,
            warehouseCode: proposal.warehouseCode,
            deltaQty: proposal.deltaQty,
            note: 'Created as a pending proposal. Stock is unchanged until an ops admin approves it.',
          };
        }),
    }),
  );
}
