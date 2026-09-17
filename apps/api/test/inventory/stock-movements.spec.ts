import type { INestApplication } from '@nestjs/common';
import { StockMovementService } from '../../src/modules/inventory/application/stock-movement.service';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { withDb } from '../helpers/identity-fixtures';
import { createTestApp } from '../helpers/test-app';

/**
 * The movements phase 04 builds ordering on. Two contracts matter:
 * `null` means the condition did not hold and **nothing** changed, and a movement
 * that did happen always leaves exactly one ledger row.
 */
describe('stock movements', () => {
  let app: INestApplication;
  let stock: StockMovementService;
  let uow: UnitOfWork;
  let product: string;
  let warehouse: string;
  let inventoryId: string;

  const state = () =>
    withDb(async (pg) => ({
      inventory: (await pg.query('SELECT * FROM commerce.inventory')).rows,
      ledger: (await pg.query('SELECT * FROM commerce.inventory_transactions ORDER BY created_at, id')).rows,
    }));

  beforeAll(async () => {
    app = await createTestApp();
    stock = app.get(StockMovementService);
    uow = app.get(UnitOfWork);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1000' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
      const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO commerce.inventory (product_id, warehouse_id, available_qty, reserved_qty)
         VALUES ($1, $2, 10, 0) RETURNING id`,
        [product, warehouse],
      );
      inventoryId = rows[0]!.id;
    });
  });

  describe('reserve', () => {
    it('moves stock from available to reserved and records the movement', async () => {
      const move = await stock.reserve(uow.db, { productId: product, warehouseId: warehouse, qty: 4 }, {
        orderId: '11111111-1111-4111-8111-111111111111',
      });
      expect(move).toEqual({
        inventoryId,
        productId: product,
        warehouseId: warehouse,
        before: { available: 10, reserved: 0 },
        after: { available: 6, reserved: 4 },
      });

      const { inventory, ledger } = await state();
      expect([inventory[0].available_qty, inventory[0].reserved_qty]).toEqual([6, 4]);
      // Nothing is created or destroyed: the total is unchanged.
      expect(inventory[0].available_qty + inventory[0].reserved_qty).toBe(10);
      expect(inventory[0].version).toBe(2);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        txn_type: 'reserve',
        quantity: 4,
        before_available_qty: 10,
        after_available_qty: 6,
        before_reserved_qty: 0,
        after_reserved_qty: 4,
        order_id: '11111111-1111-4111-8111-111111111111',
      });
    });

    it('returns null, changes nothing and writes no ledger row when stock is short', async () => {
      expect(
        await stock.reserve(uow.db, { productId: product, warehouseId: warehouse, qty: 11 }),
      ).toBeNull();
      const { inventory, ledger } = await state();
      expect([inventory[0].available_qty, inventory[0].reserved_qty, inventory[0].version]).toEqual([10, 0, 1]);
      expect(ledger).toEqual([]);
    });

    it('returns null for a pair that has no stock row at all', async () => {
      const other = await withDb((pg) => insertWarehouse(pg, { code: 'HCM-01' }));
      expect(await stock.reserve(uow.db, { productId: product, warehouseId: other, qty: 1 })).toBeNull();
      expect((await state()).ledger).toEqual([]);
    });
  });

  describe('release and consume', () => {
    beforeEach(async () => {
      await stock.reserve(uow.db, { productId: product, warehouseId: warehouse, qty: 6 });
    });

    it('release gives reserved stock back to available', async () => {
      const move = await stock.release(uow.db, { inventoryId, qty: 4 });
      expect(move).toMatchObject({
        before: { available: 4, reserved: 6 },
        after: { available: 8, reserved: 2 },
      });
      expect((await state()).ledger.at(-1)).toMatchObject({ txn_type: 'release', quantity: 4 });
    });

    it('consume drops reserved stock and leaves available alone — the goods have shipped', async () => {
      const move = await stock.consume(uow.db, { inventoryId, qty: 6 });
      expect(move).toMatchObject({
        before: { available: 4, reserved: 6 },
        after: { available: 4, reserved: 0 },
      });
      expect((await state()).ledger.at(-1)).toMatchObject({ txn_type: 'consume', quantity: 6 });
    });

    it.each([
      ['release', (qty: number) => stock.release(uow.db, { inventoryId, qty })],
      ['consume', (qty: number) => stock.consume(uow.db, { inventoryId, qty })],
    ])('%s returns null and changes nothing when more is asked than is reserved', async (_name, call) => {
      expect(await call(7)).toBeNull();
      const { inventory, ledger } = await state();
      expect([inventory[0].available_qty, inventory[0].reserved_qty]).toEqual([4, 6]);
      expect(ledger).toHaveLength(1); // only the reservation above
    });
  });

  describe('adjust', () => {
    it('leaves no trace at all when it cannot go through', async () => {
      const other = await withDb((pg) => insertWarehouse(pg, { code: 'HCM-01' }));
      // A decrease on a pair that was never stocked: no stock row may appear, or it
      // would sit at zero with no ledger row to explain it.
      expect(await stock.adjust(uow.db, { productId: product, warehouseId: other, delta: -10 })).toBeNull();
      const { inventory, ledger } = await state();
      expect(inventory).toHaveLength(1);
      expect(inventory[0].warehouse_id).toBe(warehouse);
      expect(ledger).toEqual([]);

      // And on an existing row, when the result would be negative.
      expect(
        await stock.adjust(uow.db, { productId: product, warehouseId: warehouse, delta: -11 }),
      ).toBeNull();
      const after = await state();
      expect(after.inventory[0].available_qty).toBe(10);
      expect(after.ledger).toEqual([]);
    });
  });

  describe('quantities that make no sense are refused before they reach SQL', () => {
    it.each([0, -1, 1.5])('rejects qty %j', async (qty) => {
      const bad = { code: 'INVALID_QUANTITY', status: 400 };
      await expect(
        stock.reserve(uow.db, { productId: product, warehouseId: warehouse, qty }),
      ).rejects.toMatchObject(bad);
      await expect(stock.release(uow.db, { inventoryId, qty })).rejects.toMatchObject(bad);
      await expect(stock.consume(uow.db, { inventoryId, qty })).rejects.toMatchObject(bad);
      const { inventory, ledger } = await state();
      expect([inventory[0].available_qty, inventory[0].reserved_qty]).toEqual([10, 0]);
      expect(ledger).toEqual([]);
    });

    it('rejects a zero adjustment', async () => {
      await expect(
        stock.adjust(uow.db, { productId: product, warehouseId: warehouse, delta: 0 }),
      ).rejects.toMatchObject({ code: 'INVALID_ADJUSTMENT', status: 400 });
    });
  });

  it('keeps several movements in one transaction in the order they happened', async () => {
    await uow.withTransaction(async (tx) => {
      await stock.reserve(tx, { productId: product, warehouseId: warehouse, qty: 3 }, { reason: 'first' });
      await stock.release(tx, { inventoryId, qty: 1 }, { reason: 'second' });
      await stock.consume(tx, { inventoryId, qty: 2 }, { reason: 'third' });
    });
    const { ledger } = await state();
    expect(ledger.map((r) => r.reason)).toEqual(['first', 'second', 'third']);
    // Counted in Postgres: a JS Date only keeps milliseconds, and now() would stamp
    // all three with the transaction's start time, leaving the order to a uuid.
    const distinct = await withDb((pg) =>
      pg.query('SELECT count(DISTINCT created_at)::int AS n FROM commerce.inventory_transactions'),
    );
    expect(distinct.rows[0].n).toBe(3);
  });

  it('never oversells under concurrency: 20 racing reservations on 10 units', async () => {
    const moves = await Promise.all(
      Array.from({ length: 20 }, () =>
        uow.withTransaction((tx) => stock.reserve(tx, { productId: product, warehouseId: warehouse, qty: 1 })),
      ),
    );
    expect(moves.filter((m) => m !== null)).toHaveLength(10);
    expect(moves.filter((m) => m === null)).toHaveLength(10);

    const { inventory, ledger } = await state();
    expect([inventory[0].available_qty, inventory[0].reserved_qty]).toEqual([0, 10]);
    // One ledger row per movement that happened, and no two describe the same step.
    expect(ledger).toHaveLength(10);
    expect(new Set(ledger.map((r) => r.after_available_qty)).size).toBe(10);
  });
});
