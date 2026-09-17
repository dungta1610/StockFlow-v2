import { Controller, Get, type INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { Public } from '../../src/platform/http/public.decorator';
import { RateLimiter } from '../../src/platform/ratelimit/limiter';
import { createTestApp } from '../helpers/test-app';

// Nest guards only run for matched routes, so the guard is exercised on a real one.
@Public()
@Controller('__test')
class LimitedController {
  @Get('limited/:id')
  get() {
    return { ok: true };
  }
}

describe('RateLimiter', () => {
  let app: INestApplication;
  let limiter: RateLimiter;
  let redis: Redis;

  beforeAll(async () => {
    app = await createTestApp({ extra: { controllers: [LimitedController] } });
    limiter = app.get(RateLimiter);
    redis = new Redis(process.env.REDIS_URL!);
  });
  afterAll(async () => {
    redis.disconnect();
    await app.close();
  });

  it('blocks a key past its limit without affecting other keys', async () => {
    for (let i = 0; i < 3; i++) expect(await limiter.hit('k:a', 3, 60)).toBe(true);
    expect(await limiter.hit('k:a', 3, 60)).toBe(false);
    expect(await limiter.hit('k:b', 3, 60)).toBe(true);
  });

  it('always sets an expiry on the counter (no key can block forever)', async () => {
    await limiter.hit('k:ttl', 5, 30);
    const ttl = await redis.ttl('k:ttl');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('does not extend the window on later hits', async () => {
    await limiter.hit('k:fixed', 5, 30);
    await redis.expire('k:fixed', 10);
    await limiter.hit('k:fixed', 5, 30);
    expect(await redis.ttl('k:fixed')).toBeLessThanOrEqual(10);
  });

  it('rejects invalid input like the Go version', async () => {
    expect(await limiter.hit('', 5, 30)).toBe(false);
    expect(await limiter.hit('k', 0, 30)).toBe(false);
    expect(await limiter.hit('k', 5, 0)).toBe(false);
  });

  it('isBlocked / reset support failure-only counting', async () => {
    expect(await limiter.isBlocked('k:login', 2)).toBe(false);
    await limiter.hit('k:login', 2, 60);
    await limiter.hit('k:login', 2, 60);
    expect(await limiter.isBlocked('k:login', 2)).toBe(true);
    await limiter.reset('k:login');
    expect(await limiter.isBlocked('k:login', 2)).toBe(false);
  });

  it('release gives back one hit but never creates a negative, TTL-less counter', async () => {
    await limiter.hit('k:rel', 5, 60);
    await limiter.hit('k:rel', 5, 60);
    await limiter.release('k:rel');
    expect(await redis.get('k:rel')).toBe('1');

    await limiter.release('k:absent');
    expect(await redis.exists('k:absent')).toBe(0);

    await redis.set('k:zero', '0', 'EX', 30);
    await limiter.release('k:zero');
    expect(await redis.get('k:zero')).toBe('0');
  });

  it('keeps the StockFlow key layout', () => {
    expect(RateLimiter.key('rl', '1.2.3.4', '/users/:id', 60)).toBe('rl:1.2.3.4:/users/:id:60');
  });

  describe('global guard', () => {
    it('returns 429 once a client exceeds RATE_LIMIT_MAX on a route template', async () => {
      // Default limit is 100/min. Different ids share one counter because the key
      // is the route template (/__test/limited/:id), as Gin's FullPath() was.
      const server = app.getHttpServer();
      for (let i = 0; i < 100; i++) {
        expect((await request(server).get(`/__test/limited/${i}`)).status).toBe(200);
      }
      const res = await request(server).get('/__test/limited/last');
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(res.headers['x-request-id']).toBeDefined();
    });

    it('never limits /health', async () => {
      const server = app.getHttpServer();
      for (let i = 0; i < 105; i++) await request(server).get('/health');
      expect((await request(server).get('/health')).status).toBe(200);
    });
  });
});
