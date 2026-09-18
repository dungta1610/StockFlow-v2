import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { forbidden } from '../../../platform/errors/domain-error';
import { hasRole } from '../domain/actor';
import type { Role } from '../domain/role';
import { type AuthenticatedRequest, REQUIRED_ROLES } from './auth.decorators';

/** Global guard enforcing @Roles(). Runs after JwtAuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(REQUIRED_ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const actor = ctx.switchToHttp().getRequest<AuthenticatedRequest>().actor;
    if (!actor || !hasRole(actor, ...required)) {
      // Same message and code as assertRole (modules/identity/domain/actor.ts): a
      // caller that slips past the route guard hits the identical check again in
      // the use case, so both paths must render the same failure.
      throw forbidden('You do not have the role required for this action.');
    }
    return true;
  }
}
