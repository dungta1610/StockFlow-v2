import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.tokens';

const RELEASE_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]))
if v and v > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;

/**
 * Fixed-window counter in Redis, ported from StockFlow `component/ratelimit`.
 *
 * Differences from the Go version, both deliberate:
 * - INCR and the expiry are sent in one MULTI. Go ran them as two commands, so a
 *   crash between them left a key with no TTL and blocked that client forever.
 * - The key is caller-supplied, so callers can limit by IP, user or account
 *   rather than only by client IP + path.
 *
 * Like the Go version it fails closed: if Redis errors, the request is refused.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Count one hit against `key`; true while the count stays within `limit`. */
  async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (!key || limit <= 0 || windowSeconds <= 0) return false;
    try {
      const res = await this.redis.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
      const count = Number(res?.[0]?.[1]);
      return Number.isFinite(count) && count <= limit;
    } catch {
      return false;
    }
  }

  /** True when `key` has already reached `limit` in the current window (no hit counted). */
  async isBlocked(key: string, limit: number): Promise<boolean> {
    try {
      const raw = await this.redis.get(key);
      return raw !== null && Number(raw) >= limit;
    } catch {
      return true;
    }
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key).catch(() => undefined);
  }

  /**
   * Gives back one hit. Only decrements an existing positive counter: a plain DECR on
   * a key that has just expired would recreate it at -1 with no TTL — a permanent
   * bonus attempt.
   */
  async release(key: string): Promise<void> {
    await this.redis
      .eval(RELEASE_SCRIPT, 1, key)
      .catch(() => undefined);
  }

  /** Same key layout StockFlow used: `<prefix>:<client>:<path>:<windowSeconds>`. */
  static key(prefix: string, clientId: string, path: string, windowSeconds: number): string {
    return `${prefix}:${clientId}:${path}:${windowSeconds}`;
  }
}
