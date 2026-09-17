import { resolve } from 'node:path';
import { runMigrations } from '../platform/database/migrator';

/**
 * `node dist/cli/migrate.js` — used by the `migrate` compose service and by
 * `pnpm migrate` at the repo root. MIGRATIONS_DIR defaults to the repo layout.
 */
export async function migrateCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const dir = process.env.MIGRATIONS_DIR ?? resolve(__dirname, '../../../../db/migrations');

  const { applied, skipped } = await runMigrations(databaseUrl, dir);
  console.log(`migrations: ${applied.length} applied, ${skipped.length} already applied`);
  for (const name of applied) console.log(`  + ${name}`);
}

if (require.main === module) {
  migrateCli().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
