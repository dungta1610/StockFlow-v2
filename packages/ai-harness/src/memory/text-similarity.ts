/**
 * Cheap textual near-duplicate detection, shared by the store (within one
 * namespace) and retrieval (across namespaces).
 *
 * Token overlap rather than embeddings on purpose: true MMR would mean shipping a
 * 1024-float vector per candidate back to the application on every query, which
 * costs far more than the duplicates it would catch.
 */

/** Words of two characters or more, case- and punctuation-insensitive. */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 1),
  );
}

/** Intersection over union of two token sets, in [0,1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Keep the first of any group of near-identical items, preserving input order —
 * so the caller's ranking decides which phrasing survives.
 */
export function dropNearDuplicates<T>(items: T[], maxOverlap: number, textOf: (item: T) => string): T[] {
  const kept: Array<{ item: T; tokens: Set<string> }> = [];
  for (const item of items) {
    const tokens = tokenize(textOf(item));
    if (kept.every((k) => jaccard(tokens, k.tokens) <= maxOverlap)) kept.push({ item, tokens });
  }
  return kept.map((k) => k.item);
}
