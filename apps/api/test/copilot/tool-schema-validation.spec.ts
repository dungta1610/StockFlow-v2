import type { INestApplication } from '@nestjs/common';
import { AGENT_RUNTIME, type AgentRuntime, type RunEvent } from '@stockflow/ai-harness';
import { OPS_COPILOT_AGENT } from '../../src/modules/copilot/application/agent.registry';
import { textTurn, toolTurn } from '../helpers/harness-fixtures';
import { actorsOf } from '../helpers/ordering-fixtures';
import {
  contextFor,
  createCopilotApp,
  seedCopilotWorld,
  toolFor,
  type CopilotApp,
  type CopilotWorld,
} from '../helpers/copilot-fixtures';

/**
 * Bad arguments stop at the schema.
 *
 * A model will eventually send a field that does not exist, a string where a
 * number belongs, or nothing at all. None of that should reach a service: the
 * failure belongs at the boundary, where it can be handed back to the model to
 * correct rather than surfacing as a domain error about something the operator
 * never asked for.
 */
describe('copilot tool arguments are validated at the boundary', () => {
  let fixture: CopilotApp;
  let app: INestApplication;
  let world: CopilotWorld;

  beforeAll(async () => {
    fixture = await createCopilotApp();
    app = fixture.app;
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    world = await seedCopilotWorld();
  });

  it('rejects a wrong type before the domain sees it', () => {
    const tool = toolFor(app, 'list_expiring_reservations', actorsOf(world).ops);
    expect(tool.schema.safeParse({ withinMinutes: 'soon' }).success).toBe(false);
    expect(tool.schema.safeParse({ withinMinutes: 60 }).success).toBe(true);
  });

  it('rejects a zero adjustment, which would be a proposal that changes nothing', () => {
    const tool = toolFor(app, 'propose_stock_adjustment', actorsOf(world).ops);
    const base = { sku: 'SKU-1', warehouseCode: 'HN-01', reason: 'recount' };

    expect(tool.schema.safeParse({ ...base, deltaQty: 0 }).success).toBe(false);
    expect(tool.schema.safeParse({ ...base, deltaQty: -3 }).success).toBe(true);
  });

  it('reports an invalid call back to the model instead of failing the turn', async () => {
    const runtime = app.get<AgentRuntime>(AGENT_RUNTIME);
    fixture.llm.turns = [
      toolTurn('call_1', 'get_inventory_status', { skuu: 'SKU-1' }),
      textTurn('Let me try that again.'),
    ];

    const events: RunEvent[] = [];
    for await (const event of runtime.stream({
      agentName: OPS_COPILOT_AGENT.name,
      input: 'how much SKU-1 is there?',
      context: contextFor(actorsOf(world).ops),
      tools: [toolFor(app, 'get_inventory_status', actorsOf(world).ops)],
    })) {
      events.push(event);
    }

    expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    // The model got a chance to correct itself, and its second turn is the answer.
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe(
      'Let me try that again.',
    );
  });
});
