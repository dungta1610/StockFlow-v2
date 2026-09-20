import { withDb } from '../helpers/identity-fixtures';
import { actorsOf, stockUp } from '../helpers/ordering-fixtures';
import { createCopilotApp, seedCopilotWorld, toolFor } from '../helpers/copilot-fixtures';
import type { INestApplication } from '@nestjs/common';

/**
 * The last line of defence against a self-approval is the database.
 *
 * The use case checks it first and gives a readable error, but the use case is
 * code that a future change could route around. `chk_no_self_decision` cannot be
 * routed around, which is why the guarantee that a second person looked is stated
 * as a constraint and not only as a rule.
 */
describe('a proposal cannot be decided by its author, at any level', () => {
  let app: INestApplication;
  let proposalId: string;
  let authorId: string;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    const world = await seedCopilotWorld();
    await stockUp(app, world, world.productId, world.warehouseId, 10);
    authorId = world.users.ops;
    const created = (await toolFor(app, 'propose_stock_adjustment', actorsOf(world).ops).handler({
      sku: world.sku,
      warehouseCode: world.warehouseCode,
      deltaQty: 2,
      reason: 'recount',
    })) as { proposalId: string };
    proposalId = created.proposalId;
  });

  it('rejects the write even when the use case is bypassed entirely', async () => {
    await expect(
      withDb((pg) =>
        pg.query(
          `UPDATE commerce.stock_adjustment_proposals
              SET status = 'approved', decided_by_user_id = $2, decided_at = now()
            WHERE id = $1`,
          [proposalId, authorId],
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'chk_no_self_decision' });
  });

  it('still allows anybody else to decide it', async () => {
    const [other] = await withDb(
      async (pg) =>
        (await pg.query<{ id: string }>(`SELECT id FROM commerce.users WHERE email = 'ops.admin@sf.test'`)).rows,
    );

    await withDb((pg) =>
      pg.query(
        `UPDATE commerce.stock_adjustment_proposals
            SET status = 'approved', decided_by_user_id = $2, decided_at = now()
          WHERE id = $1`,
        [proposalId, other!.id],
      ),
    );

    const [row] = await withDb(
      async (pg) =>
        (
          await pg.query<{ status: string }>(
            `SELECT status FROM commerce.stock_adjustment_proposals WHERE id = $1`,
            [proposalId],
          )
        ).rows,
    );
    expect(row!.status).toBe('approved');
  });
});
