import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bearer, withDb } from '../helpers/identity-fixtures';
import { actorsOf, stockOf, stockUp } from '../helpers/ordering-fixtures';
import { createCopilotApp, seedCopilotWorld, toolFor, type CopilotWorld } from '../helpers/copilot-fixtures';

/**
 * Deciding a proposal: who may, who may not, and what happens when they do.
 *
 * The three guarantees here are the ones the human-in-the-loop design is made of.
 * Approving is `ops_admin`. Nobody decides their own. And an approval applies the
 * adjustment exactly once, through the ordinary use case — an agent-originated
 * change is not a different kind of change.
 */
describe('stock adjustment proposals', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let world: CopilotWorld;
  let proposalId: string;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    world = await seedCopilotWorld();
    await stockUp(app, world, world.productId, world.warehouseId, 40);
    // Raised by `ops`, so `ops_admin` is a different person and may decide it.
    const created = (await toolFor(app, 'propose_stock_adjustment', actorsOf(world).ops).handler({
      sku: world.sku,
      warehouseCode: world.warehouseCode,
      deltaQty: -5,
      reason: 'Recount found five fewer',
    })) as { proposalId: string };
    proposalId = created.proposalId;
  });

  const approve = async (email: string) =>
    request(server)
      .post(`/ops/stock-adjustment-proposals/${proposalId}/approve`)
      .set('Authorization', await bearer(server, email));

  const reject = async (email: string) =>
    request(server)
      .post(`/ops/stock-adjustment-proposals/${proposalId}/reject`)
      .set('Authorization', await bearer(server, email))
      .send({});

  it('lists the queue for any operator', async () => {
    const res = await request(server)
      .get('/ops/stock-adjustment-proposals?status=pending')
      .set('Authorization', await bearer(server, 'ops@sf.test'));

    expect(res.status).toBe(200);
    // Readable without a join: SKU and warehouse code, not uuids.
    expect(res.body.data).toEqual([
      expect.objectContaining({ id: proposalId, sku: 'SKU-1', warehouse_code: 'HN-01', delta_qty: -5 }),
    ]);
  });

  it('refuses an ops user who is not an admin', async () => {
    // A second ops account, so this is about the role and not about authorship.
    await withDb(async (pg) => {
      const { rows } = await pg.query<{ id: string }>(
        `SELECT id FROM commerce.users WHERE email = 'ops.admin@sf.test'`,
      );
      return rows;
    });
    const res = await approve('ops@sf.test');
    expect(res.status).toBe(403);

    const stock = await stockOf(world.productId, world.warehouseId);
    expect(stock.available_qty).toBe(40);
  });

  it('refuses the person who raised it, even as an admin', async () => {
    // Give the author the admin role: authorship, not role, is what stops them.
    await withDb((pg) =>
      pg.query(`UPDATE commerce.org_members SET role = 'ops_admin' WHERE user_id = $1`, [world.users.ops]),
    );

    const res = await approve('ops@sf.test');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/someone other than the person who raised it/i);
  });

  it('applies the adjustment through the ordinary use case and links the ledger row', async () => {
    const res = await approve('ops.admin@sf.test');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved', decided_by_user_id: world.users.opsAdmin });

    const stock = await stockOf(world.productId, world.warehouseId);
    expect(stock.available_qty).toBe(35);

    const txnId = res.body.data.applied_transaction_id as string;
    const [entry] = await withDb(async (pg) =>
      (
        await pg.query(
          `SELECT txn_type, quantity, before_available_qty, after_available_qty, created_by, reason
             FROM commerce.inventory_transactions WHERE id = $1`,
          [txnId],
        )
      ).rows,
    );
    expect(entry).toMatchObject({
      txn_type: 'manual_adjustment',
      quantity: 5,
      before_available_qty: 40,
      after_available_qty: 35,
      created_by: world.users.opsAdmin,
      reason: 'Recount found five fewer',
    });
  });

  it('approving twice adjusts stock once', async () => {
    expect((await approve('ops.admin@sf.test')).status).toBe(200);
    const second = await approve('ops.admin@sf.test');

    expect(second.status).toBe(409);
    expect((await stockOf(world.productId, world.warehouseId)).available_qty).toBe(35);
  });

  it('rejecting records the decision and changes nothing else', async () => {
    const res = await reject('ops.admin@sf.test');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'rejected',
      decided_by_user_id: world.users.opsAdmin,
      applied_transaction_id: null,
    });
    expect((await stockOf(world.productId, world.warehouseId)).available_qty).toBe(40);
  });

  it('cannot reject what has been approved', async () => {
    expect((await approve('ops.admin@sf.test')).status).toBe(200);
    expect((await reject('ops.admin@sf.test')).status).toBe(409);
  });
});
