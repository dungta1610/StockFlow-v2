/** Small helpers shared by the handwritten-SQL repositories. */

/** StockFlow paging: 1-based page, page size. */
export interface Paging {
  page: number;
  limit: number;
}

/** Appends LIMIT/OFFSET parameters for StockFlow-style paging (page is 1-based). */
export function pagingSql(paging: Paging, params: unknown[]): string {
  params.push(paging.limit, (paging.page - 1) * paging.limit);
  return `LIMIT $${params.length - 1} OFFSET $${params.length}`;
}

/** Postgres unique_violation, optionally for a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

/** Treats `%`, `_` and `\` in user input literally inside LIKE / ILIKE. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Collects positional parameters while a WHERE clause is built.
 * `bind(v)` stores the value and returns its placeholder (`$n`).
 */
export function paramBinder(params: unknown[]): (value: unknown) => string {
  return (value) => {
    params.push(value);
    return `$${params.length}`;
  };
}
