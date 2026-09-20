import type { INestApplication } from '@nestjs/common';
import { withDb } from '../helpers/identity-fixtures';
import { actorsOf, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createCopilotApp, seedCopilotWorld, toolFor, type CopilotWorld } from '../helpers/copilot-fixtures';

/**
 * The agent's only write does not write stock.
 *
 * Letting it adjust inventory directly would put the invariants the inventory and
 * ordering work exists to protect behind a model's judgement, to save one click.
 * This test is the line: after the tool runs, the numbers are exactly what they
 * were, and the ledger has no new row (docs/adr/0024).
 */
describe('propose_stock_adjustment creates a proposal and nothing else', () => {
  let app: INestApplication;
  let world: CopilotWorld;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    world = await seedCopilotWorld();
    await stockUp(app, world, world.productId, world.warehouseId, 40);
  });

  it('leaves stock and the ledger untouched', async () => {
    const before = await stockOf(world.productId, world.warehouseId);
    const ledgerBefore = await ledgerCount();

    const result = (await toolFor(app, 'propose_stock_adjustment', actorsOf(world).ops).handler({
      sku: world.sku,
      warehouseCode: world.warehouseCode,
      deltaQty: -5,
      reason: 'Recount found five fewer',
      rationale: 'The last three counts each ran five short; the movement history shows no release.',
    })) as { proposalId: string; status: string };

    expect(result.status).toBe('pending');

    const after = await stockOf(world.productId, world.warehouseId);
    expect(after.available_qty).toBe(before.available_qty);
    expect(after.reserved_qty).toBe(before.reserved_qty);
    // No ledger row either: stock that never moved leaves no trace, and a trace
    // without a movement would be just as wrong.
    expect(await ledgerCount()).toBe(ledgerBefore);
  });

  it('records what the agent argued, and which conversation it came from', async () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    await toolFor(app, 'propose_stock_adjustment', actorsOf(world).ops, sessionId).handler({
      sku: world.sku,
      warehouseCode: world.warehouseCode,
      deltaQty: 7,
      reason: 'Found on the returns shelf',
      rationale: 'Seven units were returned last week and never booked back in.',
    });

    const [row] = await withDb(async (pg) =>
      (
        await pg.query(
          `SELECT delta_qty, reason, rationale, session_id, status, proposed_by_user_id,
                  decided_by_user_id, applied_transaction_id
             FROM commerce.stock_adjustment_proposals`,
        )
      ).rows,
    );

    expect(row).toMatchObject({
      delta_qty: 7,
      reason: 'Found on the returns shelf',
      rationale: 'Seven units were returned last week and never booked back in.',
      session_id: sessionId,
      status: 'pending',
      proposed_by_user_id: world.users.ops,
      decided_by_user_id: null,
      applied_transaction_id: null,
    });
  });

  it('refuses an unknown SKU rather than filing a proposal nobody can act on', async () => {
    const tool = toolFor(app, 'propose_stock_adjustment', actorsOf(world).ops);
    await expect(
      tool.handler({ sku: 'NOPE', warehouseCode: world.warehouseCode, deltaQty: 1, reason: 'test' }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await proposalCount()).toBe(0);
  });
});

const ledgerCount = async (): Promise<number> =>
  withDb(async (pg) => Number((await pg.query('SELECT count(*) FROM commerce.inventory_transactions')).rows[0].count));

const proposalCount = async (): Promise<number> =>
  withDb(async (pg) =>
    Number((await pg.query('SELECT count(*) FROM commerce.stock_adjustment_proposals')).rows[0].count),
  );
