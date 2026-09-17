import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

/** Arbitrary constant; serialises concurrent runners (two containers starting at once). */
const MIGRATION_LOCK_KEY = 7_020_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Forward-only migration runner (docs/adr/0002). Applies every `NNN_*.sql` file in
 * `dir` not yet recorded in `public.schema_migrations`, in filename order, each in
 * its own transaction. Rolling back means writing a new migration.
 *
 * Each applied file's SHA-256 is recorded. Editing a migration that has already run
 * is refused: the edit would never reach databases that ran the old version.
 *
 * Filename order is the apply order, which is why migration numbers must stay
 * contiguous and must not be reordered after they have run anywhere.
 */
export async function runMigrations(databaseUrl: string, dir: string): Promise<MigrationResult> {
  // Same search_path as the application pool: unqualified DDL creates commerce tables,
  // exactly where unqualified application queries will look for them.
  const client = new Client({ connectionString: databaseUrl, options: '-c search_path=commerce,public' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name       text PRIMARY KEY,
        checksum   text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    await client.query('ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum text');

    const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const { rows } = await client.query<{ name: string; checksum: string | null }>(
      'SELECT name, checksum FROM public.schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    const result: MigrationResult = { applied: [], skipped: [] };
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      // Line endings are normalised so a CRLF checkout does not look like an edit.
      const checksum = createHash('sha256')
        .update(sql.replace(/\r\n/g, '\n'))
        .digest('hex');

      if (done.has(file)) {
        const recorded = done.get(file);
        if (recorded && recorded !== checksum) {
          throw new Error(
            `Migration ${file} was modified after it was applied. Revert the edit and add a new migration instead.`,
          );
        }
        if (!recorded) {
          await client.query('UPDATE public.schema_migrations SET checksum = $1 WHERE name = $2', [checksum, file]);
        }
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
