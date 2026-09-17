import type { OrgScope } from '../domain/org-scope';

/**
 * The one place an OrgScope becomes SQL. Appends any parameter it needs to `params`
 * and returns a boolean expression over the given organisation columns.
 *
 * `all-buyers` checks the organisation *type*, so it can never match the internal
 * organisation even if a row points at it.
 */
export function scopeSql(
  scope: OrgScope,
  cols: { id: string; type: string },
  params: unknown[],
): string {
  switch (scope.kind) {
    case 'single':
      params.push(scope.orgId);
      return `${cols.id} = $${params.length}`;
    case 'all-buyers':
      return `${cols.type} = 'buyer'`;
    case 'all':
      return 'TRUE';
  }
}

/** Appends LIMIT/OFFSET parameters for StockFlow-style paging. */
export function pagingSql(paging: { page: number; limit: number }, params: unknown[]): string {
  params.push(paging.limit, (paging.page - 1) * paging.limit);
  return `LIMIT $${params.length - 1} OFFSET $${params.length}`;
}

/** Postgres unique_violation, optionally for a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
