import type { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { PG_POOL } from '../../src/platform/database/database.tokens';
import { createPool } from '../../src/platform/database/pool';
import { REDIS } from '../../src/platform/redis/redis.tokens';
import { createTestApp } from '../helpers/test-app';

// Port 1 is never listening, so connections fail fast.
const DEAD_DB = 'postgres://nobody:nothing@127.0.0.1:1/none';
const DEAD_REDIS = 'redis://127.0.0.1:1';

describe('GET /health', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('is ok when Postgres and Redis are up', async () => {
    app = await createTestApp();
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('is 503 when Postgres is down', async () => {
    app = await createTestApp({
      override: (b) =>
        b.overrideProvider(PG_POOL).useValue(
          createPool({ connectionString: DEAD_DB, lockTimeoutMs: 1000, statementTimeoutMs: 1000, max: 1 }),
        ),
    });
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'down', checks: { database: 'down', redis: 'up' } });
  });

  it('is 503 when Redis is down', async () => {
    const deadRedis = new Redis(DEAD_REDIS, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    deadRedis.on('error', () => undefined);
    app = await createTestApp({ override: (b) => b.overrideProvider(REDIS).useValue(deadRedis) });
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: 'up', redis: 'down' });
  });
});
