import { ChatTurnService, MEMORY_STORE, SessionService, type MemoryStore } from '@stockflow/ai-harness';
import { buildHarness, ORG_A, ORG_B, testAgent, textTurn, USER_A, USER_B, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * The memory namespace is resolved per request.
 *
 * `AgentDefinition.memory.scope` is a function of the run context for exactly
 * this reason: a static scope string would file two tenants' memories in one
 * bucket, and retrieval would then read one tenant's facts into the other's
 * prompt — a leak with no endpoint to blame.
 */
describe('memory scope is per request', () => {
  let fixture: HarnessFixture;
  let chat: ChatTurnService;
  let sessions: SessionService;
  let store: MemoryStore;

  beforeEach(async () => {
    fixture = await buildHarness();
    chat = fixture.module.get(ChatTurnService);
    sessions = fixture.module.get(SessionService);
    store = fixture.module.get<MemoryStore>(MEMORY_STORE);
  });
  afterEach(() => fixture.close());

  it('resolves to a different namespace for each tenant', () => {
    expect(testAgent.memory!.scope({ sessionId: 's', principal: { id: USER_A, tenantId: ORG_A } })).toBe(`org:${ORG_A}`);
    expect(testAgent.memory!.scope({ sessionId: 's', principal: { id: USER_B, tenantId: ORG_B } })).toBe(`org:${ORG_B}`);
  });

  it('consolidates each tenant into its own namespace', async () => {
    for (const [tenant, user, fact] of [
      [ORG_A, USER_A, 'Acme orders fasteners monthly'],
      [ORG_B, USER_B, 'Globex orders bearings quarterly'],
    ] as const) {
      const session = await sessions.create('assistant', { tenantId: tenant, ownerUserId: user });
      fixture.llm.turns = [textTurn('Noted.')];
      fixture.llm.completions = [{ when: () => true, reply: JSON.stringify({ memories: [{ content: fact }] }) }];

      const input = {
        agentName: 'assistant',
        input: fact,
        context: { sessionId: session.id, principal: { id: user, tenantId: tenant } },
      };
      await chat.run(input);
      await chat.settled();
    }

    expect((await store.list(`org:${ORG_A}:semantic`)).map((m) => m.content)).toEqual([
      'Acme orders fasteners monthly',
    ]);
    expect((await store.list(`org:${ORG_B}:semantic`)).map((m) => m.content)).toEqual([
      'Globex orders bearings quarterly',
    ]);
  });

  it('recalls only the calling tenant´s memory into the prompt', async () => {
    await store.upsert({ namespace: `org:${ORG_A}:semantic`, content: 'Acme orders fasteners monthly' });
    await store.upsert({ namespace: `org:${ORG_B}:semantic`, content: 'Globex orders bearings quarterly' });

    const session = await sessions.create('assistant', { tenantId: ORG_A, ownerUserId: USER_A });
    fixture.llm.turns = [textTurn('Sure.')];
    await chat.run({
      agentName: 'assistant',
      input: 'Acme orders fasteners monthly, is that still right?',
      context: { sessionId: session.id, principal: { id: USER_A, tenantId: ORG_A } },
    });

    const system = fixture.llm.chatRequests[0]!.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('Acme orders fasteners monthly');
    expect(system.content).not.toContain('Globex');
  });
});
