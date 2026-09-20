import { MEMORY_STORE, type MemoryStore } from '@stockflow/ai-harness';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildHarness, ORG_A, testStrategy, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * The cosine floor, and the gate that stops it drifting away from the model it
 * was measured against.
 *
 * 0.28 is not a taste: on Cohere Embed Multilingual v3 unrelated questions score
 * 0.17–0.25 and genuinely relevant ones 0.33–0.52, so the gap sits between them.
 * Swap the model behind the alias and those bands move — which is why the model
 * id and the floor are asserted together. Re-measuring means editing both, and
 * editing both is a change a reviewer can see.
 *
 * What this file cannot do is measure the real bands, because every test here
 * runs on a fake gateway. That measurement is the Phase 00 spike, recorded in
 * docs/adr/0003; this is the gate that makes ignoring it fail loudly.
 */
describe('memory score floor', () => {
  let fixture: HarnessFixture;
  let store: MemoryStore;
  const ns = `org:${ORG_A}:semantic`;

  beforeEach(async () => {
    fixture = await buildHarness();
    store = fixture.module.get<MemoryStore>(MEMORY_STORE);
  });
  afterEach(() => fixture.close());

  it('is the value calibrated for the configured embedding model', () => {
    const adr = readFileSync(resolve(__dirname, '../../../../docs/adr/0003-bedrock-region-models-and-tool-events.md'), 'utf8');

    expect(testStrategy.minScore).toBe(0.28);
    // Both facts live in the ADR. If the model changes there without the floor
    // being re-measured, this fails instead of retrieval quietly degrading.
    expect(adr).toMatch(/cohere\.embed-multilingual-v3/);
    expect(adr).toMatch(/0\.28/);
  });

  it('separates a relevant memory from an unrelated one', async () => {
    await store.upsert({ namespace: ns, content: 'Acme orders pallets of industrial fasteners every month' });
    await store.upsert({ namespace: ns, content: 'The office plant needs watering on Fridays' });

    const hits = await store.search(ns, 'Acme orders pallets of industrial fasteners every month', {
      minScore: testStrategy.minScore,
    });

    expect(hits.map((h) => h.content)).toEqual([
      'Acme orders pallets of industrial fasteners every month',
    ]);
  });

  it('drops a hit below the floor that no lexical match rescued', async () => {
    await store.upsert({ namespace: ns, content: 'The office plant needs watering on Fridays' });

    const hits = await store.search(ns, 'quarterly pricing negotiation with distributors', {
      minScore: testStrategy.minScore,
    });

    expect(hits).toEqual([]);
  });
});
