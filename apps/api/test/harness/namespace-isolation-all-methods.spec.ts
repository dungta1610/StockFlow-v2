import { MEMORY_STORE, type MemoryStore } from '@stockflow/ai-harness';
import { buildHarness, ORG_A, ORG_B, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * Namespace isolation, checked on every method rather than on `search` alone.
 *
 * `supersede` is the one that matters most and the one the original left open: it
 * is the only write that spans rows it was not handed, and it runs on ids a model
 * chose out of a neighbour lookup. A model naming a row from another tenant must
 * be refused by the statement, not by the caller remembering to check.
 */
describe('MemoryStore never crosses a namespace', () => {
  let fixture: HarnessFixture;
  let store: MemoryStore;
  const mine = `org:${ORG_A}:semantic`;
  const theirs = `org:${ORG_B}:semantic`;
  let theirId: number;

  beforeEach(async () => {
    fixture = await buildHarness();
    store = fixture.module.get<MemoryStore>(MEMORY_STORE);
    await store.upsert({ namespace: mine, content: 'Order volume for Acme is rising' });
    theirId = (await store.upsert({ namespace: theirs, content: 'Order volume for Acme is rising' })).id;
  });
  afterEach(() => fixture.close());

  it('search stays inside the namespaces it was given', async () => {
    const hits = await store.search([mine], 'Order volume for Acme is rising');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.namespace).toBe(mine);
  });

  it('list stays inside the namespace it was given', async () => {
    expect((await store.list(mine)).every((m) => m.namespace === mine)).toBe(true);
    expect(await store.list(mine)).toHaveLength(1);
  });

  it('neighbours stays inside the namespaces it was given', async () => {
    const near = await store.neighbours([mine], 'Order volume for Acme is rising', 10);
    expect(near.every((m) => m.namespace === mine)).toBe(true);
  });

  it('supersede refuses an id that belongs to another namespace', async () => {
    expect(await store.supersede([mine], [theirId])).toBe(0);

    const { rows } = await fixture.pool.query<{ superseded_at: Date | null }>(
      `SELECT superseded_at FROM ai.memories WHERE id = $1`,
      [theirId],
    );
    expect(rows[0]!.superseded_at).toBeNull();
    expect(await store.list(theirs)).toHaveLength(1);
  });

  it('every statement that touches existing rows carries a namespace clause', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../../../packages/ai-harness/src/memory/pgvector-memory.store.ts'),
      'utf8',
    );
    // Template literals that actually start a statement — a backtick in a
    // doc comment is not SQL, and matching those instead would test prose.
    const statements = [...source.matchAll(/`(\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b[^`]*)`/gi)].map((m) => m[1]!);
    expect(statements.length).toBeGreaterThan(0);

    for (const statement of statements) {
      // An INSERT supplies the namespace rather than filtering on one — there is
      // no existing row for a clause to protect. Everything else reads or
      // rewrites rows it was not handed, so the clause is what scopes it.
      const expected = /^\s*INSERT/i.test(statement) ? /\(\s*namespace,/ : /namespace = ANY\(/;
      expect(statement, statement.slice(0, 90)).toMatch(expected);
    }
  });
});
