import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqlLedgerRepository } from '../../src/modules/inventory/infrastructure/sql-ledger.repository';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { withDb } from '../helpers/identity-fixtures';

const methodsOf = (cls: abstract new (...args: never) => object): string[] =>
  Object.getOwnPropertyNames(cls.prototype).filter((m) => m !== 'constructor');

// The port declares only `append` and `list`; TypeScript keeps callers to that.
// This checks the implementation, which is what actually reaches the database.
describe('the ledger is append-only', () => {
  it('offers no way to change or remove a row', () => {
    expect(methodsOf(SqlLedgerRepository).sort()).toEqual(['append', 'list']);
  });

  it('writes no statement that could rewrite history', () => {
    const source = readFileSync(
      join(__dirname, '../../src/modules/inventory/infrastructure/sql-ledger.repository.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/UPDATE inventory_transactions|DELETE FROM inventory_transactions/i);
  });
});

describe('the database refuses impossible stock', () => {
  it('rejects a negative level even from raw SQL', async () => {
    await withDb(async (pg) => {
      const product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      const warehouse = await insertWarehouse(pg, { code: 'HN-01' });
      await pg.query(
        `INSERT INTO commerce.inventory (product_id, warehouse_id, available_qty) VALUES ($1, $2, 5)`,
        [product, warehouse],
      );
      await expect(pg.query('UPDATE commerce.inventory SET available_qty = -1')).rejects.toThrow(
        /chk_inventory_available_non_negative/,
      );
      await expect(pg.query('UPDATE commerce.inventory SET reserved_qty = -1')).rejects.toThrow(
        /chk_inventory_reserved_non_negative/,
      );
    });
  });

  it('rejects a ledger row with a non-positive quantity or an unknown type', async () => {
    await withDb(async (pg) => {
      const product = await insertProduct(pg, { sku: 'SKU-2', basePrice: '1000' });
      const warehouse = await insertWarehouse(pg, { code: 'HCM-01' });
      const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO commerce.inventory (product_id, warehouse_id, available_qty)
         VALUES ($1, $2, 5) RETURNING id`,
        [product, warehouse],
      );
      const insert = (txnType: string, quantity: number) =>
        pg.query(
          `INSERT INTO commerce.inventory_transactions
             (inventory_id, product_id, warehouse_id, txn_type, quantity,
              before_available_qty, after_available_qty, before_reserved_qty, after_reserved_qty)
           VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 0)`,
          [rows[0]!.id, product, warehouse, txnType, quantity],
        );
      await expect(insert('manual_adjustment', 0)).rejects.toThrow(/check constraint/);
      await expect(insert('teleport', 1)).rejects.toThrow(/check constraint/);
    });
  });
});
