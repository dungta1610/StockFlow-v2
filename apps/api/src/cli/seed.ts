import { hash } from '@node-rs/argon2';
import { Client } from 'pg';
import { SEED_PRICE_LISTS, SEED_PRODUCTS, SEED_WAREHOUSES, seedCatalog } from './seed-catalog';

/**
 * Demo tenants for local development: one internal (supplier) organisation, two
 * buyer organisations, one account per role, and one distributor account that
 * belongs to both buyers (exercises the org_code choice at login), plus the demo
 * catalog and price lists (see seed-catalog.ts).
 *
 * Every account shares SEED_PASSWORD. Because those credentials are well known, the
 * seed refuses to run unless SEED_ALLOW=true and never runs in production.
 */
export const SEED_ORGS = [
  { code: 'INTERNAL', name: 'StockFlow Supplier', type: 'internal' },
  { code: 'BUYER-A', name: 'Công ty Thương mại An Phát', type: 'buyer' },
  { code: 'BUYER-B', name: 'Công ty Phân phối Bình Minh', type: 'buyer' },
] as const;

type SeedOrgCode = (typeof SEED_ORGS)[number]['code'];

export const SEED_USERS: { email: string; fullName: string; memberships: [SeedOrgCode, string][] }[] = [
  { email: 'ops.admin@stockflow.local', fullName: 'Ops Admin', memberships: [['INTERNAL', 'ops_admin']] },
  { email: 'ops@stockflow.local', fullName: 'Ops Staff', memberships: [['INTERNAL', 'ops']] },
  { email: 'admin@buyer-a.local', fullName: 'An Phát Admin', memberships: [['BUYER-A', 'buyer_admin']] },
  { email: 'buyer@buyer-a.local', fullName: 'An Phát Buyer', memberships: [['BUYER-A', 'buyer']] },
  { email: 'admin@buyer-b.local', fullName: 'Bình Minh Admin', memberships: [['BUYER-B', 'buyer_admin']] },
  {
    email: 'distributor@stockflow.local',
    fullName: 'Multi-org Distributor',
    memberships: [
      ['BUYER-A', 'buyer'],
      ['BUYER-B', 'buyer'],
    ],
  },
];

export const DEFAULT_SEED_PASSWORD = 'ChangeMe-123!';

export class SeedRefusedError extends Error {}

type SeedEnv = Partial<Record<'SEED_ALLOW' | 'NODE_ENV' | 'SEED_PASSWORD', string | undefined>>;

export async function runSeed(databaseUrl: string, env: SeedEnv): Promise<{ password: string }> {
  if (env.SEED_ALLOW !== 'true') {
    throw new SeedRefusedError('Seed refused: set SEED_ALLOW=true to create demo accounts.');
  }
  if (env.NODE_ENV === 'production') {
    throw new SeedRefusedError('Seed refused: demo accounts are never created in production.');
  }
  const password = env.SEED_PASSWORD || DEFAULT_SEED_PASSWORD;
  const passwordHash = await hash(password);

  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    await pg.query('BEGIN');
    const orgIds = new Map<string, { id: string; type: string }>();
    for (const o of SEED_ORGS) {
      const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO commerce.organizations (code, name, type) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [o.code, o.name, o.type],
      );
      orgIds.set(o.code, { id: rows[0]!.id, type: o.type });
    }

    for (const u of SEED_USERS) {
      // Existing accounts are left as they are (their password may have been changed).
      await pg.query(
        `INSERT INTO commerce.users (email, password_hash, full_name) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING`,
        [u.email, passwordHash, u.fullName],
      );
      const { rows } = await pg.query<{ id: string }>('SELECT id FROM commerce.users WHERE email = $1', [u.email]);
      for (const [code, role] of u.memberships) {
        const org = orgIds.get(code)!;
        await pg.query(
          `INSERT INTO commerce.org_members (org_id, org_type, user_id, role) VALUES ($1, $2, $3, $4)
           ON CONFLICT (org_id, user_id) DO NOTHING`,
          [org.id, org.type, rows[0]!.id, role],
        );
      }
    }
    await seedCatalog(pg, orgIds);
    await pg.query('COMMIT');
    return { password };
  } catch (err) {
    await pg.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await pg.end();
  }
}

export async function seedCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const { password } = await runSeed(databaseUrl, process.env);
  console.log(`seed: ${SEED_ORGS.length} organisations, ${SEED_USERS.length} accounts (password: ${password})`);
  console.log(
    `seed: ${SEED_PRODUCTS.length} products, ${SEED_WAREHOUSES.length} warehouses, ${SEED_PRICE_LISTS.length} price lists`,
  );
  for (const u of SEED_USERS) {
    console.log(`  ${u.email.padEnd(30)} ${u.memberships.map(([o, r]) => `${o}:${r}`).join(', ')}`);
  }
}

if (require.main === module) {
  seedCli().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
