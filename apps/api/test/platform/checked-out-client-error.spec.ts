import type { INestApplication } from '@nestjs/common';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { withDb } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

// pg-pool stops listening for a client's 'error' event the moment it is checked
// out, and only re-attaches its listener on release. A connection lost while a
// client is checked out (database restart, failover, pg_terminate_backend) then
// emits an unlistened 'error' — an uncaught exception outside a test runner, one
// that would kill the whole process. `withTransaction` keeps a client checked out
// for the length of every transaction, so this can happen at any time.
describe('a checked-out client losing its connection mid-transaction', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('rejects the transaction, does not crash the process, and leaves the pool usable', async () => {
    const uow = app.get(UnitOfWork);

    const uncaught: unknown[] = [];
    const onUncaughtException = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaughtException);
    try {
      const txPromise = uow.withTransaction((tx) => tx.query('SELECT pg_sleep(3)'));

      // Find the backend running the sleep and kill it from a second connection,
      // so the loss happens while the client is checked out mid-transaction —
      // not while it is idle in the pool (already covered by
      // database-resilience.spec.ts).
      let pid: number | undefined;
      for (let i = 0; i < 30 && pid === undefined; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const found = await withDb((pg) =>
          pg.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
              WHERE application_name = 'stockflow-api' AND state = 'active' AND query LIKE '%pg_sleep%'`,
          ),
        );
        pid = found.rows[0]?.pid;
      }
      expect(pid).toBeDefined();

      await withDb((pg) => pg.query('SELECT pg_terminate_backend($1)', [pid]));

      await expect(txPromise).rejects.toThrow();

      // The client's 'error' event fires asynchronously and separately from the
      // query's own rejection; give it a moment to surface before checking it
      // was actually handled.
      await new Promise((r) => setTimeout(r, 300));
      expect(uncaught).toEqual([]);

      // The dead client must have been destroyed, not returned to the pool: a
      // fresh transaction still gets served.
      const rows = await uow.withTransaction((tx) => tx.query<{ ok: number }>('SELECT 1 AS ok'));
      expect(rows[0]?.ok).toBe(1);
    } finally {
      process.off('uncaughtException', onUncaughtException);
    }
  });
});
