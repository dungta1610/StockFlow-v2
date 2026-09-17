import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { runMigrations } from '../../src/platform/database/migrator';
import { MIGRATIONS_DIR } from '../global-setup';

const PROBE = '999_migrate_spec_probe.sql';

describe('migration runner', () => {
  let pg: Client;
  let dir: string;

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    dir = await mkdtemp(join(tmpdir(), 'sf-migrate-'));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    await writeFile(join(dir, PROBE), 'CREATE TABLE public.migrate_spec_probe (id int);');
  });

  afterAll(async () => {
    // The shared database outlives this file: remove the probe completely.
    await pg.query('DROP TABLE IF EXISTS public.migrate_spec_probe');
    await pg.query('DELETE FROM public.schema_migrations WHERE name = $1', [PROBE]);
    await pg.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('applies a pending migration once, then skips it', async () => {
    const first = await runMigrations(process.env.DATABASE_URL!, dir);
    expect(first.applied).toEqual([PROBE]);

    const second = await runMigrations(process.env.DATABASE_URL!, dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain(PROBE);

    const { rows } = await pg.query('SELECT 1 FROM public.schema_migrations WHERE name = $1', [PROBE]);
    expect(rows).toHaveLength(1);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    await runMigrations(process.env.DATABASE_URL!, dir);
    await writeFile(join(dir, PROBE), 'CREATE TABLE public.migrate_spec_probe (id int, extra text);');
    try {
      await expect(runMigrations(process.env.DATABASE_URL!, dir)).rejects.toThrow(
        `Migration ${PROBE} was modified after it was applied`,
      );
    } finally {
      await writeFile(join(dir, PROBE), 'CREATE TABLE public.migrate_spec_probe (id int);');
    }
    // Restoring the original content is accepted again.
    await expect(runMigrations(process.env.DATABASE_URL!, dir)).resolves.toMatchObject({ applied: [] });
  });

  it('rolls back a failing migration and does not record it', async () => {
    const bad = '998_migrate_spec_broken.sql';
    const badDir = await mkdtemp(join(tmpdir(), 'sf-migrate-bad-'));
    await writeFile(join(badDir, bad), 'CREATE TABLE public.half_done (id int); SELECT broken syntax here;');

    await expect(runMigrations(process.env.DATABASE_URL!, badDir)).rejects.toThrow(bad);

    const table = await pg.query(`SELECT to_regclass('public.half_done') AS t`);
    expect(table.rows[0].t).toBeNull();
    const rec = await pg.query('SELECT 1 FROM public.schema_migrations WHERE name = $1', [bad]);
    expect(rec.rows).toHaveLength(0);
    await rm(badDir, { recursive: true, force: true });
  });
});
