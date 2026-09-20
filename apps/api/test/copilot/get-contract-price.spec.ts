import type { INestApplication } from '@nestjs/common';
import { insertPriceList, insertTier } from '../helpers/catalog-fixtures';
import { withDb } from '../helpers/identity-fixtures';
import { actorsOf } from '../helpers/ordering-fixtures';
import { createCopilotApp, seedCopilotWorld, toolFor, type CopilotWorld } from '../helpers/copilot-fixtures';

interface PriceAnswer {
  unitPrice: string;
  sourceKind: string;
  minQtyApplied: number;
  priceListId: string | null;
}

/**
 * A price the copilot quotes has to come with its provenance.
 *
 * An operator asking "what does Acme pay for this?" is almost always really asking
 * *why* — which agreement, which quantity tier. A bare number invites the next
 * question and, worse, invites the model to invent an explanation for it.
 */
describe('get_contract_price explains where the price came from', () => {
  let app: INestApplication;
  let world: CopilotWorld;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedCopilotWorld();
  });

  const ask = (qty: number, code = 'BUYER-A'): Promise<PriceAnswer> =>
    toolFor(app, 'get_contract_price', actorsOf(world).ops).handler({
      customerOrgCode: code,
      sku: world.sku,
      qty,
    }) as Promise<PriceAnswer>;

  it('falls back to the base price, and says so', async () => {
    await expect(ask(1)).resolves.toMatchObject({
      unitPrice: '1000.00',
      sourceKind: 'base_price',
      priceListId: null,
    });
  });

  it('prefers the customer´s contract over the default list', async () => {
    await withDb(async (pg) => {
      const defaults = await insertPriceList(pg, { orgId: null, name: 'Default' });
      await insertTier(pg, { listId: defaults, productId: world.productId, minQty: 1, unitPrice: '950' });
      const contract = await insertPriceList(pg, { orgId: world.buyerA, name: 'Acme contract' });
      await insertTier(pg, { listId: contract, productId: world.productId, minQty: 1, unitPrice: '900' });
    });

    await expect(ask(1)).resolves.toMatchObject({ unitPrice: '900.00', sourceKind: 'contract' });
  });

  it('reports which quantity tier applied', async () => {
    await withDb(async (pg) => {
      const contract = await insertPriceList(pg, { orgId: world.buyerA, name: 'Acme contract' });
      await insertTier(pg, { listId: contract, productId: world.productId, minQty: 1, unitPrice: '900' });
      await insertTier(pg, { listId: contract, productId: world.productId, minQty: 50, unitPrice: '800' });
    });

    await expect(ask(10)).resolves.toMatchObject({ unitPrice: '900.00', minQtyApplied: 1 });
    await expect(ask(60)).resolves.toMatchObject({ unitPrice: '800.00', minQtyApplied: 50 });
  });

  it('gives a different customer their own price', async () => {
    await withDb(async (pg) => {
      const contract = await insertPriceList(pg, { orgId: world.buyerA, name: 'Acme contract' });
      await insertTier(pg, { listId: contract, productId: world.productId, minQty: 1, unitPrice: '900' });
    });

    await expect(ask(1, 'BUYER-B')).resolves.toMatchObject({ unitPrice: '1000.00', sourceKind: 'base_price' });
  });
});
