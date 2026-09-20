import { ChatTurnService, SessionService, type AgentRuntime, type RunEvent, type RunInput } from '@stockflow/ai-harness';
import { buildHarness, ORG_A, USER_A, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * Replacing the runtime is a DI binding and nothing else.
 *
 * That is the payoff of `ToolDefinition` being the harness's own type rather than
 * an SDK's: everything above the runtime speaks it, so a different runtime is a
 * different provider and no caller changes. It is also what keeps the door open
 * to a Strands-backed runtime if the tool-event question is ever answered — see
 * docs/adr/0021.
 */
describe('AgentRuntime is swappable', () => {
  let fixture: HarnessFixture;
  const seen: RunInput[] = [];

  /** A runtime that never talks to a model. */
  const fakeRuntime: AgentRuntime = {
    async *stream(input: RunInput): AsyncIterable<RunEvent> {
      seen.push(input);
      yield { type: 'text', delta: 'fake ' };
      yield { type: 'text', delta: 'answer' };
    },
    async run(input: RunInput) {
      seen.push(input);
      return { text: 'fake answer', toolCalls: [] };
    },
  };

  beforeEach(async () => {
    seen.length = 0;
    fixture = await buildHarness({ runtime: fakeRuntime });
  });
  afterEach(() => fixture.close());

  it('runs a whole turn on the replacement, with no model call anywhere', async () => {
    const sessions = fixture.module.get(SessionService);
    const session = await sessions.create('assistant', { tenantId: ORG_A, ownerUserId: USER_A });
    const context = { sessionId: session.id, principal: { id: USER_A, tenantId: ORG_A } };

    const events: RunEvent[] = [];
    for await (const event of fixture.module.get(ChatTurnService).stream({
      agentName: 'assistant',
      input: 'hello',
      context,
    })) {
      events.push(event);
    }

    expect(events.map((e) => (e.type === 'text' ? e.delta : e.type)).join('')).toBe('fake answer');
    expect(fixture.llm.chatRequests).toEqual([]);
  });

  it('still does the turn´s own work: tools built, history replayed, reply stored', async () => {
    const sessions = fixture.module.get(SessionService);
    const session = await sessions.create('assistant', { tenantId: ORG_A, ownerUserId: USER_A });
    const context = { sessionId: session.id, principal: { id: USER_A, tenantId: ORG_A } };

    await fixture.module.get(ChatTurnService).run({ agentName: 'assistant', input: 'hello', context });

    expect(seen[0]!.tools.map((t) => t.name)).toEqual(['calculator']);
    // The prompt is not replayed as history as well as being the prompt.
    expect(seen[0]!.history).toEqual([]);

    const stored = await sessions.getMessages(session.id, { tenantId: ORG_A });
    expect(stored.map((m) => `${m.role}:${m.content}`)).toEqual(['user:hello', 'assistant:fake answer']);
  });
});
