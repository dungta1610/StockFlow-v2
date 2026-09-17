import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
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
      throw new ForbiddenException('You do not have the role required for this action.');
    }
    return true;
  }
}
