import type { OrgScope } from '../domain/org-scope';

/**
 * The one place an OrgScope becomes SQL. Appends any parameter it needs to `params`
 * and returns a boolean expression over the given organisation columns. Other
 * modules import it to scope their own organisation-owned tables.
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
