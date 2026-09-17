// Local-dev entry point: loads the root .env and creates the demo tenants.
// Requires SEED_ALLOW=true. Usage: pnpm seed
import 'dotenv/config';
import { seedCli } from '../apps/api/src/cli/seed';

seedCli().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
