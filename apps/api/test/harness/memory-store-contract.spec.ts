import { MEMORY_STORE, type MemoryStore } from '@stockflow/ai-harness';
import { buildHarness, ORG_A, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * The contract every MemoryStore has to satisfy, run against real pgvector.
 * Swapping to another vector store means making this file pass again.
 */
describe('MemoryStore contract', () => {
  let fixture: HarnessFixture;
  let store: MemoryStore;
  const ns = `org:${ORG_A}:semantic`;

  beforeEach(async () => {
    fixture = await buildHarness();
    store = fixture.module.get<MemoryStore>(MEMORY_STORE);
  });
  afterEach(() => fixture.close());

  it('stores a memory and finds it again', async () => {
    const written = await store.upsert({ namespace: ns, content: 'Khánh works at ECV' });
    expect(written.id).toBeGreaterThan(0);
    expect(written.importance).toBe(0.5);

    const hits = await store.search(ns, 'Khánh works at ECV');
    expect(hits.map((h) => h.content)).toContain('Khánh works at ECV');
  });

  it('collapses an identical restatement into the row that already holds it', async () => {
    const first = await store.upsert({ namespace: ns, content: 'Khánh works at ECV' });
    const second = await store.upsert({ namespace: ns, content: 'Khánh works at ECV' });
    expect(second.id).toBe(first.id);

    expect(await store.list(ns)).toHaveLength(1);
  });

  it('keeps a superseded row in the table but out of retrieval', async () => {
    const written = await store.upsert({ namespace: ns, content: 'Khánh drinks black coffee' });
    expect(await store.supersede([ns], [written.id])).toBe(1);

    expect(await store.list(ns)).toEqual([]);
    expect(await store.search(ns, 'Khánh drinks black coffee')).toEqual([]);

    // Still there: a wrong supersede has to be auditable and recoverable.
    const { rows } = await fixture.pool.query<{ count: string }>(
      `SELECT count(*) FROM ai.memories WHERE id = $1 AND superseded_at IS NOT NULL`,
      [written.id],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('superseding the same row twice reports no second change', async () => {
    const written = await store.upsert({ namespace: ns, content: 'Khánh lives in Saigon' });
    expect(await store.supersede([ns], [written.id])).toBe(1);
    expect(await store.supersede([ns], [written.id])).toBe(0);
  });

  it('returns neighbours regardless of any score floor', async () => {
    await store.upsert({ namespace: ns, content: 'Khánh prefers short answers' });
    const near = await store.neighbours([ns], 'something entirely unrelated to that', 3);
    expect(near).toHaveLength(1);
    expect(near[0]!.score).toBeDefined();
  });

  it('lists newest first', async () => {
    await store.upsert({ namespace: ns, content: 'first fact about work' });
    await store.upsert({ namespace: ns, content: 'second fact about travel' });
    const listed = await store.list(ns);
    expect(listed.map((m) => m.content)).toEqual(['second fact about travel', 'first fact about work']);
  });
});
