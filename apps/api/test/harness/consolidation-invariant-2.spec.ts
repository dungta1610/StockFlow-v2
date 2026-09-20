import { ChatTurnService, MEMORY_STORE, SessionService, type MemoryStore } from '@stockflow/ai-harness';
import { buildHarness, ORG_A, textTurn, USER_A, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * Invariant 2: consolidation is gated by a forward marker, not by a message total.
 *
 * Gating on `count % N === 0` misses conversations outright — one complete turn
 * is two messages, so a single-turn chat sits at 2 forever, and an aborted reply
 * leaves the count odd past every multiple of N. A user who says their name once
 * and expects it remembered is exactly the case that breaks.
 *
 * The marker also advances *before* the pass runs, so a failed pass is not retried
 * on every following turn. Nothing is lost by that, because a later pass re-reads
 * the whole transcript — which this file asserts rather than assumes.
 */
describe('consolidation gating', () => {
  let fixture: HarnessFixture;
  let chat: ChatTurnService;
  let sessions: SessionService;
  let store: MemoryStore;
  const scope = { tenantId: ORG_A };

  const extraction = (content: string) => ({
    when: () => true,
    reply: JSON.stringify({ memories: [{ content, importance: 0.6 }] }),
  });

  beforeEach(async () => {
    fixture = await buildHarness();
    chat = fixture.module.get(ChatTurnService);
    sessions = fixture.module.get(SessionService);
    store = fixture.module.get<MemoryStore>(MEMORY_STORE);
  });
  afterEach(() => fixture.close());

  async function newSession(): Promise<string> {
    return (await sessions.create('assistant', { tenantId: ORG_A, ownerUserId: USER_A })).id;
  }

  it('forms memory from a conversation exactly one turn long', async () => {
    const sessionId = await newSession();
    fixture.llm.turns = [textTurn('Nice to meet you.')];
    fixture.llm.completions = [extraction('The user is called Khánh')];

    const input = {
      agentName: 'assistant',
      input: 'My name is Khánh.',
      context: { sessionId, principal: { id: USER_A, tenantId: ORG_A } },
    };
    await chat.run(input);
    await chat.settled();

    const stored = await store.list(`org:${ORG_A}:semantic`);
    expect(stored.map((m) => m.content)).toContain('The user is called Khánh');
  });

  it('advances the marker before the pass, so a failed pass is not retried every turn', async () => {
    const sessionId = await newSession();
    await sessions.addMessage(sessionId, scope, 'user', 'first');
    await sessions.addMessage(sessionId, scope, 'assistant', 'second');

    expect(await sessions.claimConsolidation(sessionId, scope, 2)).toBe(true);
    // The marker moved even though no pass has succeeded, so the same two
    // messages do not re-trigger a pass on the next turn.
    expect(await sessions.claimConsolidation(sessionId, scope, 2)).toBe(false);
  });

  it('re-reads the whole transcript, so a skipped pass is late rather than lost', async () => {
    const sessionId = await newSession();
    const input = (text: string) => ({
      agentName: 'assistant',
      input: text,
      context: { sessionId, principal: { id: USER_A, tenantId: ORG_A } },
    });

    // First turn: the pass is claimed but the extraction call fails.
    fixture.llm.turns = [textTurn('Noted.')];
    fixture.llm.completions = [{ when: () => true, reply: 'not json at all' }];
    await chat.run(input('My name is Khánh.'));
    await chat.settled();
    expect(await store.list(`org:${ORG_A}:semantic`)).toEqual([]);

    // Second turn: the pass reads the whole transcript, first turn included.
    fixture.llm.turns = [textTurn('Understood.')];
    fixture.llm.completions = [extraction('The user is called Khánh')];
    await chat.run(input('And I prefer short answers.'));
    await chat.settled();

    const extractionPrompt = fixture.llm.completePrompts.at(-1)!;
    expect(extractionPrompt).toContain('My name is Khánh.');
    expect((await store.list(`org:${ORG_A}:semantic`)).map((m) => m.content)).toContain(
      'The user is called Khánh',
    );
  });
});
