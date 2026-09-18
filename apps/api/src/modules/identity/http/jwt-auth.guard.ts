import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenService } from '../application/ports/access-token.service';
import { IdentityErrors } from '../domain/errors';
import { type AuthenticatedRequest, IS_PUBLIC } from './auth.decorators';

/**
 * Global guard: authenticated by default. A route is reachable without a token only
 * if it is marked @Public().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (req.header('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw IdentityErrors.missingToken();

    const actor = await this.tokens.verify(token);
    if (!actor) throw IdentityErrors.invalidToken();
    req.actor = actor;
    return true;
  }
}
