import { ConsolidationService, MEMORY_STORE, type MemoryStore } from '@stockflow/ai-harness';
import { buildHarness, ORG_A, testStrategy, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * Invariant 1: adjudication covers every namespace retrieval reads.
 *
 * A pass *writes* to `<scope>:<strategy>` but must *judge* against
 * `[<scope>, <scope>:<strategy>]`. Drop the bare scope and a memory written
 * directly can never be contradicted — retrieval keeps recalling it as fact,
 * outliving the correction that was supposed to replace it, and nothing anywhere
 * reports a problem.
 *
 * The rule to carry forward: adding a namespace to the read path means adding it
 * to `adjudicateAgainst`.
 */
describe('consolidation adjudicates against the bare scope', () => {
  let fixture: HarnessFixture;
  let store: MemoryStore;
  const scope = `org:${ORG_A}`;
  const strategyNs = `${scope}:semantic`;

  beforeEach(async () => {
    fixture = await buildHarness();
    store = fixture.module.get<MemoryStore>(MEMORY_STORE);
  });
  afterEach(() => fixture.close());

  it('supersedes a directly-written memory that a new fact contradicts', async () => {
    // Written straight to the bare scope, as an API write would be.
    const stale = await store.upsert({ namespace: scope, content: 'Acme pays on Net-30 terms' });

    fixture.llm.completions = [
      {
        when: (p) => p.includes('"decisions"'),
        reply: JSON.stringify({ decisions: [{ candidate: 0, action: 'replace', replaces: [stale.id] }] }),
      },
      {
        when: () => true,
        reply: JSON.stringify({ memories: [{ content: 'Acme pays on Net-60 terms', importance: 0.7 }] }),
      },
    ];

    const outcomes = await fixture.module.get(ConsolidationService).consolidate({
      scope,
      strategies: [testStrategy],
      transcript: [{ role: 'user', content: 'We moved Acme to Net-60 terms.' }],
    });

    expect(outcomes[0]!.superseded).toContain(stale.id);

    // Gone from the bare scope's read path, and the replacement is in the
    // strategy namespace.
    expect(await store.list(scope)).toEqual([]);
    expect((await store.list(strategyNs)).map((m) => m.content)).toEqual(['Acme pays on Net-60 terms']);
  });

  it('shows the model neighbours from both namespaces', async () => {
    await store.upsert({ namespace: scope, content: 'Acme pays on Net-30 terms' });
    await store.upsert({ namespace: strategyNs, content: 'Acme pays on Net-30 terms' });

    fixture.llm.completions = [
      { when: (p) => p.includes('"decisions"'), reply: JSON.stringify({ decisions: [] }) },
      { when: () => true, reply: JSON.stringify({ memories: [{ content: 'Acme pays on Net-30 terms' }] }) },
    ];

    await fixture.module.get(ConsolidationService).consolidate({
      scope,
      strategies: [testStrategy],
      transcript: [{ role: 'user', content: 'Acme still on Net-30?' }],
    });

    const adjudication = fixture.llm.completePrompts.find((p) => p.includes('"decisions"'));
    expect(adjudication).toBeDefined();
    // Two rows offered as neighbours means both namespaces were searched.
    expect([...adjudication!.matchAll(/- id \d+:/g)]).toHaveLength(2);
  });
});
