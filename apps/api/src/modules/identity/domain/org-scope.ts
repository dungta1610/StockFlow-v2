import { type Actor, isInternalOps } from './actor';
import { IdentityErrors } from './errors';
import type { OrgType } from './role';

/**
 * Which organisations' data a caller may read. Services take an OrgScope instead of
 * a bare organisation id, so "forgot to filter by tenant" is a type error and
 * internal ops staff can read customer data without any bypass branch.
 *
 * - `single`     — one organisation (every buyer).
 * - `all-buyers` — every buyer organisation, never the internal one (ops reading
 *                  commerce data).
 * - `all`        — every organisation including internal (ops administering identity).
 */
export type OrgScope =
  | { kind: 'single'; orgId: string }
  | { kind: 'all-buyers' }
  | { kind: 'all' };

/** Scope for commerce data: orders, prices, inventory views. */
export function orgScopeOf(actor: Actor): OrgScope {
  return isInternalOps(actor) ? { kind: 'all-buyers' } : { kind: 'single', orgId: actor.orgId };
}

/** Scope for identity data: organisations and their members. */
export function identityScopeOf(actor: Actor): OrgScope {
  return isInternalOps(actor) ? { kind: 'all' } : { kind: 'single', orgId: actor.orgId };
}

export function scopeIncludes(scope: OrgScope, org: { id: string; type: OrgType }): boolean {
  switch (scope.kind) {
    case 'single':
      return scope.orgId === org.id;
    case 'all-buyers':
      return org.type === 'buyer';
    case 'all':
      return true;
  }
}

/**
 * Guard for callers that name a specific organisation (a request body, a query
 * string, a tool argument chosen by a model). Never trust that id without this.
 * Throws "not found" rather than "forbidden" so the check does not confirm that an
 * out-of-scope organisation exists.
 */
export function assertOrgInScope(scope: OrgScope, org: { id: string; type: OrgType }): void {
  if (!scopeIncludes(scope, org)) throw IdentityErrors.organizationNotFound();
}
