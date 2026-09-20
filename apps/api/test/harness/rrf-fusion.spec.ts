import { RRF_K, rrfScore } from '@stockflow/ai-harness';

/**
 * Reciprocal rank fusion, as arithmetic. The point of fusing by rank rather than
 * by score is that cosine similarity and ts_rank_cd are not on comparable scales,
 * so nothing here may depend on a score's magnitude.
 */
describe('reciprocal rank fusion', () => {
  it('follows the formula', () => {
    expect(rrfScore({ vector: 1, lexical: null })).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(rrfScore({ vector: null, lexical: 3 })).toBeCloseTo(1 / (RRF_K + 3), 10);
    expect(rrfScore({ vector: 2, lexical: 5 })).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 5), 10);
  });

  it('ranks a document found by both branches above one found by either alone', () => {
    const both = rrfScore({ vector: 5, lexical: 5 });
    expect(both).toBeGreaterThan(rrfScore({ vector: 1, lexical: null }));
    expect(both).toBeGreaterThan(rrfScore({ vector: null, lexical: 1 }));
  });

  it('keeps rank order within a branch', () => {
    expect(rrfScore({ vector: 1, lexical: null })).toBeGreaterThan(rrfScore({ vector: 2, lexical: null }));
  });

  it('scores a document neither branch returned at zero', () => {
    expect(rrfScore({ vector: null, lexical: null })).toBe(0);
  });
});
