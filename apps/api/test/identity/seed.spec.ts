import { SEED_USERS, SeedRefusedError, runSeed } from '../../src/cli/seed';
import { SEED_PRICE_LISTS, SEED_PRODUCTS, SEED_WAREHOUSES } from '../../src/cli/seed-catalog';
import { withDb } from '../helpers/identity-fixtures';

describe('seed', () => {
  const url = () => process.env.DATABASE_URL!;

  it('refuses to run unless SEED_ALLOW=true', async () => {
    await expect(runSeed(url(), { SEED_ALLOW: undefined, NODE_ENV: 'development' })).rejects.toBeInstanceOf(
      SeedRefusedError,
    );
    await expect(runSeed(url(), { SEED_ALLOW: 'yes', NODE_ENV: 'development' })).rejects.toBeInstanceOf(
      SeedRefusedError,
    );
    const { rows } = await withDb((pg) => pg.query('SELECT count(*)::int AS n FROM commerce.users'));
    expect(rows[0].n).toBe(0);
  });

  it('refuses to run in production even when allowed', async () => {
    await expect(runSeed(url(), { SEED_ALLOW: 'true', NODE_ENV: 'production' })).rejects.toBeInstanceOf(
      SeedRefusedError,
    );
  });

  it('creates the demo tenants and can be run repeatedly', async () => {
    const env = { SEED_ALLOW: 'true', NODE_ENV: 'development', SEED_PASSWORD: 'seed-password-1' };
    await runSeed(url(), env);
    await runSeed(url(), env);

    await withDb(async (pg) => {
      const orgs = await pg.query('SELECT code, type FROM commerce.organizations ORDER BY code');
      expect(orgs.rows).toEqual([
        { code: 'BUYER-A', type: 'buyer' },
        { code: 'BUYER-B', type: 'buyer' },
        { code: 'INTERNAL', type: 'internal' },
      ]);
      const users = await pg.query('SELECT count(*)::int AS n FROM commerce.users');
      expect(users.rows[0].n).toBe(SEED_USERS.length);
      // Every role is represented, and one account belongs to two organisations.
      const roles = await pg.query('SELECT DISTINCT role FROM commerce.org_members ORDER BY role');
      expect(roles.rows.map((r) => r.role)).toEqual(['buyer', 'buyer_admin', 'ops', 'ops_admin']);
      const multi = await pg.query(
        'SELECT user_id FROM commerce.org_members GROUP BY user_id HAVING count(*) > 1',
      );
      expect(multi.rows).toHaveLength(1);
    });
  });

  it('seeds a catalog whose two contracts price the same SKU differently', async () => {
    const env = { SEED_ALLOW: 'true', NODE_ENV: 'development' };
    await runSeed(url(), env);
    await runSeed(url(), env);

    await withDb(async (pg) => {
      const count = async (table: string) =>
        (await pg.query(`SELECT count(*)::int AS n FROM commerce.${table}`)).rows[0].n;
      expect(await count('products')).toBe(SEED_PRODUCTS.length);
      expect(SEED_PRODUCTS).toHaveLength(20);
      expect(await count('warehouses')).toBe(SEED_WAREHOUSES.length);
      expect(await count('price_lists')).toBe(SEED_PRICE_LISTS.length);

      // A SKU covered by both contracts, first tier: each buyer sees its own price.
      const { rows } = await pg.query(
        `SELECT o.code, i.unit_price
           FROM commerce.price_list_items i
           JOIN commerce.price_lists l ON l.id = i.price_list_id
           JOIN commerce.organizations o ON o.id = l.org_id
           JOIN commerce.products p ON p.id = i.product_id
          WHERE p.sku = 'MARKER-WB-02' AND i.min_qty = 1
          ORDER BY o.code`,
      );
      expect(rows.map((r) => r.code)).toEqual(['BUYER-A', 'BUYER-B']);
      expect(rows[0].unit_price).not.toBe(rows[1].unit_price);

      const tiers = await pg.query(
        'SELECT DISTINCT min_qty FROM commerce.price_list_items WHERE min_qty > 1 ORDER BY min_qty',
      );
      expect(tiers.rows.length).toBeGreaterThan(0);
    });
  });
});
