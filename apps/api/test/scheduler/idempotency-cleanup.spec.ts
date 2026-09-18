import type { INestApplication } from '@nestjs/common';
import { IdempotencyCleanupJob } from '../../src/modules/ordering/application/idempotency-cleanup.job';
import { seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

interface KeyRow {
  key: string;
  status: 'in_progress' | 'completed' | 'failed';
  createdHoursAgo: number;
  updatedHoursAgo: number;
}

const insertKey = (t: Tenants, row: KeyRow) =>
  withDb((pg) =>
    pg.query(
      `INSERT INTO commerce.idempotency_keys
         (org_id, endpoint, key, request_hash, status, response_status, response_snapshot, created_at, updated_at)
       VALUES ($1, 'POST /orders', $2, 'hash', $3,
               CASE WHEN $3 = 'completed' THEN 201 END,
               CASE WHEN $3 = 'completed' THEN '{}'::jsonb END,
               now() - ($4 || ' hours')::interval, now() - ($5 || ' hours')::interval)`,
      [t.buyerA, row.key, row.status, row.createdHoursAgo, row.updatedHoursAgo],
    ),
  );

const keyExists = (key: string) =>
  withDb(async (pg) => {
    const { rows } = await pg.query('SELECT 1 FROM commerce.idempotency_keys WHERE key = $1', [key]);
    return rows.length > 0;
  });

describe('the idempotency-key cleanup job', () => {
  let app: INestApplication;
  let job: IdempotencyCleanupJob;

  beforeAll(async () => {
    app = await createTestApp();
    job = app.get(IdempotencyCleanupJob);
  });
  afterAll(() => app.close());

  it('deletes a completed key past its TTL and keeps one still within it', async () => {
    const t = await seedTenants();
    // IDEMPOTENCY_TTL_HOURS default is 24.
    await insertKey(t, { key: 'old-completed', status: 'completed', createdHoursAgo: 100, updatedHoursAgo: 100 });
    await insertKey(t, { key: 'recent-completed', status: 'completed', createdHoursAgo: 1, updatedHoursAgo: 1 });

    await job.run();

    expect(await keyExists('old-completed')).toBe(false);
    expect(await keyExists('recent-completed')).toBe(true);
  });

  it('does not delete a key re-claimed after its original attempt failed, even though it was first created past the TTL', async () => {
    const t = await seedTenants();
    // Created 25h ago and failed, then retried just now: claim() re-takes a
    // `failed` key with `status = 'in_progress', updated_at = now()` but never
    // resets created_at — the row is "old" by created_at and "live" by updated_at.
    await insertKey(t, { key: 'retried-old', status: 'in_progress', createdHoursAgo: 25, updatedHoursAgo: 0 });

    await job.run();

    // Cleanup by created_at would have deleted this mid-flight, and the request
    // it belongs to would see IdempotencyService.complete() throw "no longer held".
    expect(await keyExists('retried-old')).toBe(true);
  });

  it('still deletes a key genuinely stuck in_progress once its own TTL passes (a worker that died)', async () => {
    const t = await seedTenants();
    await insertKey(t, { key: 'stuck-in-progress', status: 'in_progress', createdHoursAgo: 100, updatedHoursAgo: 100 });

    await job.run();

    expect(await keyExists('stuck-in-progress')).toBe(false);
  });
});
