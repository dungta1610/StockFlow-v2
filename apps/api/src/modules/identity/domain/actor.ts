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

/**
 * Sentinel id for the system actor below. It is not a row in `users`, so any code
 * writing it to a column with a foreign key to `users` (e.g. `audit_log.actor_user_id`)
 * must treat it as "no human actor" and store null instead.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The actor in-process jobs act as — the reservation-expiry sweep today, and any
 * job added later that must call a use case without an HTTP request behind it. Ops
 * rights, scoped to every buyer organisation (`OrgScope` `all-buyers` — see
 * `orgScopeOf`), no human session. Defined once here so a job never invents its own
 * bypass of the role and scope checks every other caller goes through.
 */
export const systemActor: Actor = {
  userId: SYSTEM_ACTOR_ID,
  orgId: SYSTEM_ACTOR_ID,
  orgType: 'internal',
  roles: ['ops_admin'],
};
