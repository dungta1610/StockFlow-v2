import type { INestApplication } from '@nestjs/common';
import { OPS_COPILOT_TOOLS } from '../../src/modules/copilot/application/agent.registry';
import { actorsOf } from '../helpers/ordering-fixtures';
import { createCopilotApp, seedCopilotWorld, toolFor, type CopilotWorld } from '../helpers/copilot-fixtures';

/**
 * A tool never has more access than the person holding the conversation.
 *
 * The check lives in the application services and in the copilot's own actor
 * resolution, not in the controller. That matters because a tool is reachable
 * wherever the harness runs — a scheduled summary, a future buyer copilot — and a
 * guard that exists only at the HTTP edge is a guard with a way around it.
 */
describe('copilot tools enforce the caller´s role', () => {
  let app: INestApplication;
  let world: CopilotWorld;

  beforeAll(async () => {
    ({ app } = await createCopilotApp());
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedCopilotWorld();
  });

  it.each(OPS_COPILOT_TOOLS)('refuses %s for a buyer', async (name) => {
    const tool = toolFor(app, name, actorsOf(world).buyerA);
    // Arguments do not matter: the caller is rejected before anything is looked up.
    await expect(tool.handler(argumentsFor(name))).rejects.toMatchObject({ status: 403 });
  });

  it('allows an operator through to the domain', async () => {
    const tool = toolFor(app, 'get_inventory_status', actorsOf(world).ops);
    await expect(tool.handler({ sku: world.sku })).resolves.toMatchObject({ sku: 'SKU-1' });
  });
});

/** Valid arguments per tool, so a rejection can only be about authorisation. */
function argumentsFor(name: string): Record<string, unknown> {
  switch (name) {
    case 'get_inventory_status':
    case 'inventory_movement_history':
      return { sku: 'SKU-1' };
    case 'find_orders':
      return {};
    case 'explain_order_blockers':
      return { orderCode: 'ORD-000001' };
    case 'list_expiring_reservations':
      return { withinMinutes: 60 };
    case 'get_contract_price':
      return { customerOrgCode: 'BUYER-A', sku: 'SKU-1', qty: 1 };
    case 'propose_stock_adjustment':
      return { sku: 'SKU-1', warehouseCode: 'HN-01', deltaQty: 1, reason: 'test' };
    default:
      throw new Error(`No arguments defined for tool "${name}" — add them when adding the tool.`);
  }
}
