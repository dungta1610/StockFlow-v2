import { AGENT_RUNTIME, calculatorTool, type AgentRuntime, type RunEvent } from '@stockflow/ai-harness';
import { buildHarness, ORG_A, textTurn, toolTurn, USER_A, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * Tool lifecycle events on the stream.
 *
 * This is the capability the whole AI half of the product hangs on: the console
 * shows which tool an answer came from and how long it took. The runtime emits
 * these itself, around handlers it calls, which is why they exist at all — the
 * SDK the harness was ported from only ever yielded text deltas, and no wrapper
 * can add information a stream never carried.
 */
describe('AgentRuntime tool lifecycle events', () => {
  let fixture: HarnessFixture;
  let runtime: AgentRuntime;

  const context = { sessionId: '00000000-0000-0000-0000-0000000000aa', principal: { id: USER_A, tenantId: ORG_A } };

  beforeEach(async () => {
    fixture = await buildHarness();
    runtime = fixture.module.get<AgentRuntime>(AGENT_RUNTIME);
  });
  afterEach(() => fixture.close());

  async function collect(tools = [calculatorTool(context)]): Promise<RunEvent[]> {
    const events: RunEvent[] = [];
    for await (const event of runtime.stream({ agentName: 'assistant', input: 'what is 15 * 23?', context, tools })) {
      events.push(event);
    }
    return events;
  }

  it('emits tool_start then tool_end with a matching call id and a real duration', async () => {
    fixture.llm.turns = [toolTurn('call_1', 'calculator', { expression: '15 * 23' }), textTurn('345')];

    const events = await collect();
    const start = events.find((e) => e.type === 'tool_start');
    const end = events.find((e) => e.type === 'tool_end');

    expect(events.findIndex((e) => e.type === 'tool_start')).toBeLessThan(
      events.findIndex((e) => e.type === 'tool_end'),
    );
    expect(start).toMatchObject({ callId: 'call_1', name: 'calculator', input: { expression: '15 * 23' } });
    expect(end).toMatchObject({ callId: 'call_1', name: 'calculator', ok: true });
    expect(end?.type === 'tool_end' ? end.durationMs : 0).toBeGreaterThan(0);
  });

  it('streams the answer text alongside the tool events', async () => {
    fixture.llm.turns = [toolTurn('call_1', 'calculator', { expression: '15 * 23' }), textTurn('345')];

    const events = await collect();
    const text = events
      .filter((e): e is Extract<RunEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('345');
  });

  it('reports ok=false when a handler throws, and tells the model instead of failing the turn', async () => {
    const exploding = () => ({
      ...calculatorTool(context),
      handler: async () => {
        throw new Error('tool exploded');
      },
    });
    fixture.llm.turns = [toolTurn('call_1', 'calculator', { expression: '1 + 1' }), textTurn('sorry, that failed')];

    const events = await collect([exploding()]);
    const end = events.find((e) => e.type === 'tool_end');

    expect(end).toMatchObject({ ok: false, error: 'tool exploded' });
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // The failure went back as a tool message so the model could react to it.
    const second = fixture.llm.chatRequests[1]!;
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', content: 'tool exploded' });
  });

  it('reports ok=false when the model sends arguments the schema rejects', async () => {
    fixture.llm.turns = [toolTurn('call_1', 'calculator', { wrong: 1 }), textTurn('let me try again')];

    const end = (await collect()).find((e) => e.type === 'tool_end');
    expect(end).toMatchObject({ ok: false });
  });

  it('assembles tool arguments split across stream chunks', async () => {
    fixture.llm.turns = [toolTurn('call_1', 'calculator', { expression: '2 * (3 + 4)' }), textTurn('14')];

    const start = (await collect()).find((e) => e.type === 'tool_start');
    expect(start).toMatchObject({ input: { expression: '2 * (3 + 4)' } });
  });
});
