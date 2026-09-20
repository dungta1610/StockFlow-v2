import { defineTool, toolFactory, type ToolFactory } from '@stockflow/ai-harness';
import { z } from 'zod';
import { CatalogService } from '../../../catalog/application/catalog.service';
import { CatalogErrors } from '../../../catalog/domain/errors';
import { OrganizationRepository } from '../../../identity/application/ports/organization.repository';
import { assertOrgInScope } from '../../../identity/domain/org-scope';
import { IdentityErrors } from '../../../identity/domain/errors';
import { QuotePricesUseCase } from '../../../pricing/application/use-cases/quote-prices.use-case';
import type { ToolDeps } from './tool-deps';

/**
 * The one read tool that must name an organisation other than the caller's —
 * "what does customer A pay for this SKU?" is a question operators ask daily.
 *
 * Two things keep that safe. It takes the customer's **code**, not a uuid: a model
 * cannot invent a code that happens to exist nearly as easily as it can invent a
 * uuid. And the code is resolved inside the caller's scope and then checked again
 * with `assertOrgInScope`, so an organisation the caller may not see reads as "not
 * found" — never as a price.
 */
const schema = z.object({
  customerOrgCode: z.string().describe('Customer organisation code, e.g. "ACME".'),
  sku: z.string().describe('Product SKU.'),
  qty: z.number().int().positive().describe('Quantity, because price tiers depend on it.'),
});

export function makeGetContractPriceTool(
  quotes: QuotePricesUseCase,
  organizations: OrganizationRepository,
  catalog: CatalogService,
  deps: ToolDeps,
): ToolFactory {
  return toolFactory('get_contract_price', (ctx) =>
    defineTool({
      name: 'get_contract_price',
      description:
        'The unit price one customer pays for a SKU at a given quantity, with where that price came from ' +
        '(their contract, the default list, or the base price) and which quantity tier applied.',
      schema,
      handler: ({ customerOrgCode, sku, qty }) =>
        deps.read(ctx, async (db, { actor, scope }) => {
          const [customer] = await organizations.list(
            db,
            scope,
            { code: customerOrgCode.trim().toUpperCase() },
            { page: 1, limit: 1 },
          );
          if (!customer) throw IdentityErrors.organizationNotFound();
          assertOrgInScope(scope, customer);

          const product = await catalog.findProductBySku(db, sku);
          if (!product) throw CatalogErrors.productNotFound();

          const quote = await quotes.execute(
            db,
            actor,
            { customerOrgId: customer.id, lines: [{ productId: product.id, qty }] },
            new Date(),
          );
          const line = quote.lines[0]!;
          return {
            customerOrgCode: customer.code,
            sku: line.sku,
            qty: line.qty,
            unitPrice: line.unitPrice.toString(),
            lineTotal: line.lineTotal.toString(),
            // Why this number, not just what it is: an operator asking about a price
            // is usually asking which agreement produced it.
            sourceKind: line.sourceKind,
            minQtyApplied: line.minQtyApplied,
            priceListId: line.priceListId,
          };
        }),
    }),
  );
}
