import type { INestApplication } from '@nestjs/common';
import { withDb } from '../helpers/identity-fixtures';
import { insertPriceList, insertTier } from '../helpers/catalog-fixtures';
import { actorsOf } from '../helpers/ordering-fixtures';
import { createCopilotApp, seedCopilotWorld, toolFor, type CopilotWorld } from '../helpers/copilot-fixtures';

/**
 * The one tool that must name an organisation other than the caller's.
 *
 * "What does customer A pay for this SKU?" is a daily question, so the field has
 * to exist — which makes this the single place a model's choice reaches a tenant
 * boundary. Two things stand in the way: the code is resolved *inside* the
 * caller's scope, and the result is checked again before it is used.
 */
describe('get_contract_price only prices customers in scope', () => {
  let app: INestApplication;
  let world: CopilotWorld;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    world = await seedCopilotWorld();
    await withDb(async (pg) => {
      const list = await insertPriceList(pg, { orgId: world.buyerA, name: 'Acme contract' });
      await insertTier(pg, { listId: list, productId: world.productId, minQty: 1, unitPrice: '900' });
    });
  });

  it('prices a buyer organisation for an operator, and says where the price came from', async () => {
    const tool = toolFor(app, 'get_contract_price', actorsOf(world).ops);

    await expect(tool.handler({ customerOrgCode: 'BUYER-A', sku: 'SKU-1', qty: 1 })).resolves.toMatchObject({
      customerOrgCode: 'BUYER-A',
      unitPrice: '900.00',
      sourceKind: 'contract',
      minQtyApplied: 1,
    });
  });

  it('refuses the internal organisation, which is not a customer', async () => {
    const tool = toolFor(app, 'get_contract_price', actorsOf(world).ops);

    // `all-buyers` covers every buyer and nothing else: the internal organisation
    // reads as "not found" rather than as a price.
    await expect(tool.handler({ customerOrgCode: 'INTERNAL', sku: 'SKU-1', qty: 1 })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses an unknown organisation code without confirming anything about it', async () => {
    const tool = toolFor(app, 'get_contract_price', actorsOf(world).ops);

    await expect(tool.handler({ customerOrgCode: 'NOPE', sku: 'SKU-1', qty: 1 })).rejects.toMatchObject({
      status: 404,
    });
  });
});
