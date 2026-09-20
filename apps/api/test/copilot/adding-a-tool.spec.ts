import { ToolRegistry, defineTool, toolFactory } from '@stockflow/ai-harness';
import { z } from 'zod';
import type { INestApplication } from '@nestjs/common';
import { OPS_COPILOT_TOOLS } from '../../src/modules/copilot/application/agent.registry';
import { InventoryService } from '../../src/modules/inventory/application/inventory.service';
import { ToolDeps } from '../../src/modules/copilot/application/tools/tool-deps';
import { actorsOf, stockUp } from '../helpers/ordering-fixtures';
import { contextFor, createCopilotApp, seedCopilotWorld, type CopilotWorld } from '../helpers/copilot-fixtures';

/**
 * The extensibility claim, checked rather than asserted.
 *
 * An eighth tool should be one file and one line: a factory that calls an
 * application service, registered alongside the others. Nothing in
 * `packages/ai-harness` should need to change — if it did, the harness would not
 * really be domain-agnostic, it would just not have met the domain yet.
 */
describe('adding a tool', () => {
  let app: INestApplication;
  let world: CopilotWorld;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedCopilotWorld();
    await stockUp(app, world, world.productId, world.warehouseId, 7);
  });

  it('is a factory plus a registration, with no change to the harness', async () => {
    const deps = app.get(ToolDeps);
    const inventory = app.get(InventoryService);

    // Everything an eighth tool is: schema, one service call, the caller's context.
    const isStockLow = toolFactory('is_stock_low', (ctx) =>
      defineTool({
        name: 'is_stock_low',
        description: 'Whether a SKU is below a threshold.',
        schema: z.object({ sku: z.string(), threshold: z.number().int().positive() }),
        handler: ({ sku, threshold }) =>
          deps.read(ctx, async (db, { actor }) => {
            const status = await inventory.getStatus(db, actor, { sku });
            return { sku, available: status.total.available, low: status.total.available < threshold };
          }),
      }),
    );

    const registry = app.get(ToolRegistry);
    registry.register(isStockLow);

    const [tool] = registry.build(['is_stock_low'], contextFor(actorsOf(world).ops));
    await expect(tool!.handler({ sku: world.sku, threshold: 10 })).resolves.toEqual({
      sku: 'SKU-1',
      available: 7,
      low: true,
    });

    // The same caller rules apply to it for free, because they live in the service.
    const [forBuyer] = registry.build(['is_stock_low'], contextFor(actorsOf(world).buyerA));
    await expect(forBuyer!.handler({ sku: world.sku, threshold: 10 })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a name that is already taken, rather than shadowing a tool', () => {
    const clash = toolFactory('get_inventory_status', () =>
      defineTool({
        name: 'get_inventory_status',
        description: 'impostor',
        schema: z.object({}),
        handler: async () => 'nothing',
      }),
    );

    expect(() => app.get(ToolRegistry).register(clash)).toThrow(/already registered/);
  });

  it('keeps the agent´s tool list and the registry in step', () => {
    // The agent naming a tool nobody registered is caught at boot; this is the
    // same check, stated where a reader of the tests can see it.
    expect(() => app.get(ToolRegistry).assertKnown(OPS_COPILOT_TOOLS)).not.toThrow();
  });
});
