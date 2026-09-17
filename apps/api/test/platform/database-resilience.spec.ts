import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { PG_POOL } from '../../src/platform/database/database.tokens';
import { withDb } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

// A database restart terminates every idle pooled connection. Without an 'error'
// listener on the pool, that event crashes the Node process.
describe('database connection loss', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('survives idle connections being killed and recovers on the next request', async () => {
    const pool = app.get<Pool>(PG_POOL);
    // Warm the pool so there are idle clients to kill.
    await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 1'), pool.query('SELECT 1')]);
    expect(pool.idleCount).toBeGreaterThan(0);

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('uncaughtException', onUnhandled);
    try {
      await withDb((pg) =>
        pg.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE application_name = 'stockflow-api'
              AND datname = current_database() AND state = 'idle'`,
        ),
      );
      await new Promise((r) => setTimeout(r, 300));

      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.checks.database).toBe('up');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('uncaughtException', onUnhandled);
    }
  });
});
