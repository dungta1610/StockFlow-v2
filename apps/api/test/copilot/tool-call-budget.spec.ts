import type { INestApplication } from '@nestjs/common';
import { AGENT_RUNTIME, HARNESS_CONFIG, type AgentRuntime, type ResolvedHarnessConfig, type RunEvent } from '@stockflow/ai-harness';
import { OPS_COPILOT_AGENT } from '../../src/modules/copilot/application/agent.registry';
import { toolTurn } from '../helpers/harness-fixtures';
import { actorsOf, stockUp } from '../helpers/ordering-fixtures';
import {
  contextFor,
  createCopilotApp,
  seedCopilotWorld,
  toolFor,
  type CopilotApp,
  type CopilotWorld,
} from '../helpers/copilot-fixtures';

/**
 * A model that keeps calling tools stops, on a budget the deployment sets.
 *
 * Each tool result goes back to the model, which may call another tool. Without a
 * ceiling that is an unbounded spend loop whose only natural end is some other
 * timeout — and the operator sits watching a spinner in the meantime. The stop is
 * controlled: whatever was streamed stands, and the caller is told why it ended.
 */
describe('copilot tool-call budget', () => {
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
    await stockUp(app, world, world.productId, world.warehouseId, 5);
  });

  it('stops after the configured number of rounds instead of looping', async () => {
    const maxRounds = app.get<ResolvedHarnessConfig>(HARNESS_CONFIG).chat.maxToolRounds;
    // A model that never stops asking: more tool turns queued than the budget allows.
    fixture.llm.turns = Array.from({ length: maxRounds + 5 }, (_, i) =>
      toolTurn(`call_${i}`, 'get_inventory_status', { sku: 'SKU-1' }),
    );

    const events: RunEvent[] = [];
    for await (const event of app.get<AgentRuntime>(AGENT_RUNTIME).stream({
      agentName: OPS_COPILOT_AGENT.name,
      input: 'check SKU-1 again and again',
      context: contextFor(actorsOf(world).ops),
      tools: [toolFor(app, 'get_inventory_status', actorsOf(world).ops)],
    })) {
      events.push(event);
    }

    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(maxRounds);
    expect(fixture.llm.chatRequests).toHaveLength(maxRounds);
    // Ended deliberately, and said so.
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: 'error' });
    expect((last as { message: string }).message).toMatch(new RegExp(`${maxRounds} tool rounds`));
  });

  it('leaves the budget unspent when the model answers straight away', async () => {
    fixture.llm.turns = [
      toolTurn('call_1', 'get_inventory_status', { sku: 'SKU-1' }),
      [{ textDelta: 'Five units.' }, { finishReason: 'stop' }],
    ];

    const events: RunEvent[] = [];
    for await (const event of app.get<AgentRuntime>(AGENT_RUNTIME).stream({
      agentName: OPS_COPILOT_AGENT.name,
      input: 'how much SKU-1?',
      context: contextFor(actorsOf(world).ops),
      tools: [toolFor(app, 'get_inventory_status', actorsOf(world).ops)],
    })) {
      events.push(event);
    }

    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
