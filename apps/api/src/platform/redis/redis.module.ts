import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env.schema';
import { REDIS } from './redis.tokens';

/**
 * Shared Redis client. It does not queue commands while disconnected, so a Redis
 * outage surfaces as a fast error (health → 503, limiter fails closed) instead of
 * requests hanging on an offline queue.
 *
 * Because of that, boot waits for the first connection: otherwise the first
 * requests after startup would hit a not-yet-connected client and be refused by
 * the fail-closed limiter. A Redis that is down at boot does not stop the API —
 * ioredis keeps reconnecting in the background.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Redis(config.get('REDIS_URL', { infer: true }), {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 2_000,
          retryStrategy: (times) => Math.min(times * 200, 2_000),
        }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    // Without a listener, connection errors would be thrown as unhandled events.
    // ioredis retries continuously, so log at most once per interval.
    let lastLogged = 0;
    this.redis.on('error', (err: Error) => {
      if (Date.now() - lastLogged < 30_000) return;
      lastLogged = Date.now();
      this.logger.warn(`Redis error: ${err.message}`);
    });
    if (this.redis.status !== 'wait') return;
    try {
      await this.redis.connect();
    } catch (err) {
      this.logger.warn(`Redis unavailable at startup: ${(err as Error).message}`);
    }
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}
