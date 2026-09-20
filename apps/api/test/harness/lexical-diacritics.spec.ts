import { MEMORY_STORE, type MemoryStore } from '@stockflow/ai-harness';
import { buildHarness, ORG_A, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * The lexical branch folds diacritics.
 *
 * This is the case hybrid search exists for: an exact name typed without its
 * accents. The vector branch ranks such a query poorly — embeddings are bad at
 * exact tokens — so if `simple_unaccent` is not wired up, nothing finds it.
 */
describe('lexical retrieval folds diacritics', () => {
  let fixture: HarnessFixture;
  let store: MemoryStore;
  const ns = `org:${ORG_A}:semantic`;

  beforeEach(async () => {
    fixture = await buildHarness();
    store = fixture.module.get<MemoryStore>(MEMORY_STORE);
  });
  afterEach(() => fixture.close());

  it('matches "Khanh" against a memory written "Khánh"', async () => {
    await store.upsert({ namespace: ns, content: 'Khánh thích cà phê đen' });
    await store.upsert({ namespace: ns, content: 'Completely unrelated sentence about logistics' });

    const hits = await store.search(ns, 'Khanh', { minScore: 0.9 });

    // Found, and found despite a cosine floor it could not have cleared — which
    // is the rule: a lexical hit survives the floor.
    expect(hits.map((h) => h.content)).toEqual(['Khánh thích cà phê đen']);
    expect(hits[0]!.lexical).toBe(true);
  });
});
