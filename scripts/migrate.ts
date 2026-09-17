// Local-dev entry point: loads the root .env, then runs the same migration CLI the
// container uses. Usage: pnpm migrate
import 'dotenv/config';
import { resolve } from 'node:path';
import { migrateCli } from '../apps/api/src/cli/migrate';

process.env.MIGRATIONS_DIR ??= resolve(__dirname, '../db/migrations');

migrateCli().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
