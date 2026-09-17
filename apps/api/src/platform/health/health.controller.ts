import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.tokens';
import { Public } from '../http/public.decorator';
import { SkipRateLimit } from '../ratelimit/skip-rate-limit.decorator';
import { REDIS } from '../redis/redis.tokens';

const CHECK_TIMEOUT_MS = 2_000;

type CheckStatus = 'up' | 'down';

const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS)),
  ]);

const probe = async (fn: () => Promise<unknown>): Promise<CheckStatus> => {
  try {
    await withTimeout(fn());
    return 'up';
  } catch {
    return 'down';
  }
};

/**
 * Liveness of the API and its two hard dependencies, ported from StockFlow's
 * `/health` (Postgres ping + Redis ping, 503 if either is down). Exempt from the
 * rate limiter, as it was in StockFlow.
 */
@Controller('health')
@Public()
@SkipRateLimit()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const [database, redis] = await Promise.all([
      probe(() => this.pool.query('SELECT 1')),
      probe(() => this.redis.ping()),
    ]);
    const ok = database === 'up' && redis === 'up';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'down', checks: { database, redis } };
  }
}
