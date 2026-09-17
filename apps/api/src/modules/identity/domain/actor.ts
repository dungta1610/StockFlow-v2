import { forbidden } from '../../../platform/errors/domain-error';
import { isOpsRole, type OrgType, type Role } from './role';

/**
 * The authenticated caller, rebuilt from the access token on every request.
 * Application services take it (or the OrgScope derived from it) as their first
 * argument; the copilot passes the same value to its tools, which is what keeps an
 * agent from ever having more access than the person using it.
 */
export interface Actor {
  userId: string;
  /** The organisation this session acts for (chosen at login). */
  orgId: string;
  orgType: OrgType;
  roles: Role[];
}

export const hasRole = (actor: Actor, ...roles: Role[]): boolean =>
  actor.roles.some((r) => roles.includes(r));

/** Ops rights only count inside the internal organisation. */
export const isInternalOps = (actor: Actor): boolean =>
  actor.orgType === 'internal' && actor.roles.some(isOpsRole);

/**
 * Use-case-level authorisation. Route decorators are not enough: application
 * services are also called outside HTTP (jobs, agent tools), and those callers must
 * hit the same check. Ops roles only count inside the internal organisation.
 */
export function assertRole(actor: Actor, ...allowed: Role[]): void {
  const ok = actor.roles.some(
    (r) => allowed.includes(r) && (!isOpsRole(r) || actor.orgType === 'internal'),
  );
  if (!ok) throw forbidden('You do not have the role required for this action.');
}
