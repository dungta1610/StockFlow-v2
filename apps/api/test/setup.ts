import Redis from 'ioredis';
import { Client } from 'pg';
import { afterAll, beforeEach, inject } from 'vitest';

// Must run before any test file imports AppModule: @nestjs/config reads
// process.env at import time.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = inject('databaseUrl');
process.env.REDIS_URL = inject('redisUrl');
// Later concurrency tests hold ~50 connections at once.
process.env.DB_POOL_MAX = '60';
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.LOGIN_MAX_ATTEMPTS = '5';
process.env.LOGIN_MAX_ATTEMPTS_PER_IP = '20';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);
const ready = pg.connect();

/** Every test starts from empty tables and an empty Redis. */
beforeEach(async () => {
  await ready;
  const { rows } = await pg.query<{ table: string }>(`
    SELECT format('%I.%I', schemaname, tablename) AS table
      FROM pg_tables
     WHERE schemaname IN ('commerce', 'ai')`);
  if (rows.length > 0) {
    await pg.query(`TRUNCATE ${rows.map((r) => r.table).join(', ')} RESTART IDENTITY CASCADE`);
  }
  await redis.flushdb();
});

afterAll(async () => {
  await pg.end();
  redis.disconnect();
});
