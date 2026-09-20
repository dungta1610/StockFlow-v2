import type { INestApplication } from '@nestjs/common';
import { z } from 'zod';
import { OPS_COPILOT_TOOLS } from '../../src/modules/copilot/application/agent.registry';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { CreateOrderUseCase } from '../../src/modules/ordering/application/use-cases/create-order.use-case';
import { actorsOf, stockUp } from '../helpers/ordering-fixtures';
import { createCopilotApp, seedCopilotWorld, toolFor, type CopilotWorld } from '../helpers/copilot-fixtures';

/** Every field of every copilot tool, by name. */
function fieldNames(schema: z.ZodType): string[] {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  return Object.keys(shape ?? {});
}

/**
 * Which organisations' data comes back is decided by the caller's `OrgScope` —
 * never by the model.
 *
 * The second test is the structural half of that claim: there is no field a model
 * could put an organisation into, except the one place an operator genuinely has
 * to name a customer, which is checked against the scope separately.
 */
describe('copilot tools are scoped by the caller, not by the model', () => {
  let app: INestApplication;
  let world: CopilotWorld;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
  });
  afterAll(() => app.close());

  beforeEach(async () => {
    world = await seedCopilotWorld();
    await stockUp(app, world, world.productId, world.warehouseId, 100);
    const uow = app.get(UnitOfWork);
    const create = app.get(CreateOrderUseCase);
    for (const buyer of ['buyerA', 'buyerB'] as const) {
      await uow.withTransaction((tx) =>
        create.execute(
          tx,
          actorsOf(world)[buyer],
          { warehouseId: world.warehouseId, items: [{ productId: world.productId, quantity: 1 }] },
          new Date(),
        ),
      );
    }
  });

  it('shows an operator every buyer organisation´s orders', async () => {
    const tool = toolFor(app, 'find_orders', actorsOf(world).ops);
    const orders = (await tool.handler({})) as Array<{ buyerOrgId: string }>;

    expect(new Set(orders.map((o) => o.buyerOrgId))).toEqual(new Set([world.buyerA, world.buyerB]));
  });

  it('has no organisation field for a model to fill in', () => {
    const actor = actorsOf(world).ops;
    const tenantish = /org|tenant|organisation|organization|buyer/i;

    for (const name of OPS_COPILOT_TOOLS) {
      const fields = fieldNames(toolFor(app, name, actor).schema);
      const offenders = fields.filter((f) => tenantish.test(f));
      // The single exception, and the reason it is safe: it takes a *code*, which is
      // then resolved inside the caller's scope and re-checked (see
      // customer-org-must-be-in-scope.spec.ts).
      const allowed = name === 'get_contract_price' ? ['customerOrgCode'] : [];
      expect(offenders, `${name}: ${offenders.join(', ')}`).toEqual(allowed);
    }
  });
});
