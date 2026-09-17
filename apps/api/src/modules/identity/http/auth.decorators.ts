import { type ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { Actor } from '../domain/actor';
import { type OrgScope, orgScopeOf } from '../domain/org-scope';
import type { Role } from '../domain/role';

export { IS_PUBLIC, Public } from '../../../platform/http/public.decorator';

export const REQUIRED_ROLES = 'requiredRoles';

/** Requires the caller to hold at least one of the roles. */
export const Roles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);

export type AuthenticatedRequest = Request & { actor?: Actor };

/** The authenticated caller (set by JwtAuthGuard). */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): Actor => {
  const actor = ctx.switchToHttp().getRequest<AuthenticatedRequest>().actor;
  if (!actor) throw new Error('CurrentActor used on a route without authentication');
  return actor;
});

/** The caller's scope over commerce data (orders, prices, inventory). */
export const CurrentScope = createParamDecorator((_: unknown, ctx: ExecutionContext): OrgScope => {
  const actor = ctx.switchToHttp().getRequest<AuthenticatedRequest>().actor;
  if (!actor) throw new Error('CurrentScope used on a route without authentication');
  return orgScopeOf(actor);
});
