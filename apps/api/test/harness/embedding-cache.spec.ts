import { EmbeddingService } from '@stockflow/ai-harness';
import { buildHarness, type HarnessFixture } from '../helpers/harness-fixtures';

/**
 * The embedding cache, and the part of its key that is easy to leave out.
 *
 * `input_type` belongs in the key because the model is asymmetric: the same
 * sentence embeds differently as a stored document than as a search query. Key it
 * on content and model alone and the cache serves the wrong half of the pair —
 * no error, no warning, just similarity numbers that stop matching the floor they
 * were calibrated against.
 */
describe('embedding cache', () => {
  let fixture: HarnessFixture;
  let embeddings: EmbeddingService;

  beforeEach(async () => {
    fixture = await buildHarness();
    embeddings = fixture.module.get(EmbeddingService);
  });
  afterEach(() => fixture.close());

  it('calls the gateway once for the same text, model and input type', async () => {
    const first = await embeddings.embed('kiểm tra tồn kho', 'document');
    const second = await embeddings.embed('kiểm tra tồn kho', 'document');

    expect(fixture.llm.embedCalls).toHaveLength(1);
    // Not bit-identical: pgvector stores float4, so a cached vector comes back
    // rounded. Every vector it is compared against went through the same
    // rounding, which is why the similarity numbers stay consistent.
    expect(second).toHaveLength(first.length);
    second.forEach((value, i) => expect(value).toBeCloseTo(first[i]!, 6));
  });

  it('misses on the same text with a different input type, and the vectors differ', async () => {
    const asDocument = await embeddings.embed('kiểm tra tồn kho', 'document');
    const asQuery = await embeddings.embed('kiểm tra tồn kho', 'query');

    expect(fixture.llm.embedCalls.map((c) => c.purpose)).toEqual(['document', 'query']);
    expect(asQuery).not.toEqual(asDocument);
  });

  it('keys the stored row on all three parts', async () => {
    await embeddings.embed('kiểm tra tồn kho', 'document');
    await embeddings.embed('kiểm tra tồn kho', 'query');

    const { rows } = await fixture.pool.query<{ input_type: string; model: string }>(
      `SELECT input_type, model FROM ai.embedding_cache ORDER BY input_type`,
    );
    expect(rows.map((r) => r.input_type)).toEqual(['search_document', 'search_query']);
    expect(new Set(rows.map((r) => r.model))).toEqual(new Set(['default-embed']));
  });
});
