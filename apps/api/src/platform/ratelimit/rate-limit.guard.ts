import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Env } from '../config/env.schema';
import { RateLimiter } from './limiter';
import { SKIP_RATE_LIMIT } from './skip-rate-limit.decorator';

/**
 * Global limiter, ported from StockFlow `middleware/ratelimit.go`: N requests per
 * window per client IP + route template.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly reflector: Reflector,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (skip) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const clientId = req.ip || 'unknown';
    // Route template (e.g. /users/:id), like Gin's FullPath(); raw path as fallback.
    const routePath = (req.route as { path?: string } | undefined)?.path;
    const path = routePath ? `${req.baseUrl}${routePath}` : req.path;
    const window = this.config.get('RATE_LIMIT_WINDOW_SECONDS', { infer: true });
    const max = this.config.get('RATE_LIMIT_MAX', { infer: true });

    const allowed = await this.limiter.hit(RateLimiter.key('rl', clientId, path, window), max, window);
    if (!allowed) {
      throw new HttpException('Rate limit exceeded.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
