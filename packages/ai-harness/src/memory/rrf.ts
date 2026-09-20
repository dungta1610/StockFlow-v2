/**
 * Reciprocal rank fusion.
 *
 * Hybrid search runs a vector branch and a lexical branch whose scores are not on
 * comparable scales — cosine similarity against ts_rank_cd — so they are fused by
 * *rank* instead of by score, which needs no normalisation.
 *
 * The arithmetic lives here rather than in the SQL that produced the ranks. Both
 * branches are already bounded to a small candidate pool, so fusing in TypeScript
 * costs nothing, keeps the formula in exactly one place, and makes it testable
 * without a database.
 */

/**
 * Damping constant. At k=60 the gap between rank 1 and rank 2 stays meaningful
 * while the tail flattens, so one branch ranking a document first cannot by
 * itself outweigh both branches ranking another document highly.
 */
export const RRF_K = 60;

export interface BranchRanks {
  /** 1-based rank in the vector branch, or null when that branch missed it. */
  vector: number | null;
  /** 1-based rank in the lexical branch, or null when that branch missed it. */
  lexical: number | null;
}

/**
 * A document found by both branches scores the sum of both contributions, which
 * is what lifts it above a document only one branch liked.
 */
export function rrfScore(ranks: BranchRanks): number {
  const vec = ranks.vector === null ? 0 : 1 / (RRF_K + ranks.vector);
  const lex = ranks.lexical === null ? 0 : 1 / (RRF_K + ranks.lexical);
  return vec + lex;
}
