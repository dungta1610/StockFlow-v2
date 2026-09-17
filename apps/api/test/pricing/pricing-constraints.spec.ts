import { insertPriceList, insertProduct } from '../helpers/catalog-fixtures';
import { insertOrg, withDb } from '../helpers/identity-fixtures';

// Rules the database itself enforces, whatever the application does.
describe('catalog and pricing constraints', () => {
  it('refuses any currency other than VND', async () => {
    await withDb(async (pg) => {
      await expect(
        pg.query(`INSERT INTO commerce.products (sku, name, base_price, currency) VALUES ('X', 'X', 1, 'USD')`),
      ).rejects.toThrow(/check constraint/);
      await expect(
        pg.query(`INSERT INTO commerce.price_lists (name, valid_from, currency) VALUES ('x', now(), 'USD')`),
      ).rejects.toThrow(/check constraint/);
    });
  });

  it('refuses negative prices', async () => {
    await withDb(async (pg) => {
      await expect(insertProduct(pg, { sku: 'NEG', basePrice: '-1' })).rejects.toThrow(/check constraint/);
    });
  });

  it('stores codes only in normalised form', async () => {
    await withDb(async (pg) => {
      await expect(insertProduct(pg, { sku: 'lower', basePrice: '1' })).rejects.toThrow(/check constraint/);
      await expect(
        pg.query(`INSERT INTO commerce.warehouses (code, name) VALUES (' WH ', 'x')`),
      ).rejects.toThrow(/check constraint/);
    });
  });

  it('allows contract price lists only for buyer organisations', async () => {
    await withDb(async (pg) => {
      const internal = await insertOrg(pg, { code: 'INT', type: 'internal' });
      // Claiming the internal org is a buyer breaks the composite foreign key…
      await expect(insertPriceList(pg, { orgId: internal })).rejects.toThrow(/foreign key/);
      // …and telling the truth breaks the owner check.
      await expect(
        pg.query(
          `INSERT INTO commerce.price_lists (org_id, org_type, name, valid_from) VALUES ($1, 'internal', 'x', now())`,
          [internal],
        ),
      ).rejects.toThrow(/chk_price_list_owner/);
    });
  });

  it('refuses a validity window that ends before it starts', async () => {
    await withDb(async (pg) => {
      await expect(
        insertPriceList(pg, { validFrom: '2026-02-01T00:00:00Z', validTo: '2026-01-01T00:00:00Z' }),
      ).rejects.toThrow(/chk_price_list_validity/);
    });
  });

  it('reads numeric back as an exact string, never a float', async () => {
    await withDb(async (pg) => {
      await insertProduct(pg, { sku: 'EXACT', basePrice: '9999999999999999.99' });
      const { rows } = await pg.query(`SELECT base_price FROM commerce.products WHERE sku = 'EXACT'`);
      expect(rows[0].base_price).toBe('9999999999999999.99');
    });
  });
});
