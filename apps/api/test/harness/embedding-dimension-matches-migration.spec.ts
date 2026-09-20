import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EMBED_DIMENSIONS } from '../helpers/harness-fixtures';

/**
 * The configured embedding width and the column that has to hold it.
 *
 * They are set in two files that nothing links, and a mismatch does not surface
 * until the first write of a real vector — in a background consolidation pass, on
 * whatever machine has credentials. Asserting them against each other turns that
 * into a failure here.
 *
 * Changing the embedding model means changing the column type AND re-embedding
 * every stored row; it is not a config tweak. See docs/adr/0003.
 */
describe('embedding dimension', () => {
  const migration = readFileSync(
    resolve(__dirname, '../../../../db/migrations/009_ai_memory.sql'),
    'utf8',
  );

  it('matches the vector(N) of every embedding column in migration 009', () => {
    const widths = [...migration.matchAll(/vector\((\d+)\)/g)].map((m) => Number(m[1]));

    expect(widths.length).toBeGreaterThanOrEqual(2); // memories + embedding_cache
    for (const width of widths) expect(width).toBe(EMBED_DIMENSIONS);
  });

  it('is rejected at the gateway when a model returns a different width', async () => {
    const { buildHarness, FakeLlmGateway } = await import('../helpers/harness-fixtures');
    const { EmbeddingService } = await import('@stockflow/ai-harness');

    const llm = new FakeLlmGateway();
    llm.embed = async () => new Array(768).fill(0.1);

    const fixture = await buildHarness({ llm });
    try {
      await expect(fixture.module.get(EmbeddingService).embed('anything', 'document')).rejects.toThrow(
        /768 dimensions but the harness is configured for 1024/,
      );
    } finally {
      await fixture.close();
    }
  });
});
