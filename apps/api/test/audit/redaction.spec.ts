import type { INestApplication } from '@nestjs/common';
import { OutboxRelay } from '../../src/platform/outbox/outbox.relay';
import { insertProduct, insertWarehouse } from '../helpers/catalog-fixtures';
import { bearer, seedTenants, withDb, type Tenants } from '../helpers/identity-fixtures';
import { postOrder, stockUp } from '../helpers/ordering-fixtures';
import { createTestApp } from '../helpers/test-app';

/** No key anywhere in the object tree, at any depth (summary.items is an array of objects). */
function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      collectKeys(v, keys);
    }
  }
}

/** Every primitive value anywhere in the tree — money always serialises as a fixed
 *  two-decimal string (`Money.toString()`), so this catches a money amount under
 *  any field name, not only the ones we thought to name. */
function collectValues(value: unknown, values: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, values);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectValues(v, values);
  } else {
    values.push(value);
  }
}
const MONEY_SHAPED = /^\d+\.\d{2}$/;

describe('audit_log.summary redacts pricing fields', () => {
  let app: INestApplication;
  let relay: OutboxRelay;
  let t: Tenants;
  let product: string;
  let warehouse: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
    relay = app.get(OutboxRelay);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    t = await seedTenants();
    await withDb(async (pg) => {
      product = await insertProduct(pg, { sku: 'SKU-1', basePrice: '1234.50' });
      warehouse = await insertWarehouse(pg, { code: 'HN-01' });
    });
    await stockUp(app, t, product, warehouse, 10);
  });

  it('order.created keeps status/timestamps/quantities but no money amount at all, even for a single-line order', async () => {
    const buyer = await bearer(server(), 'buyer@a.test');
    // A single line at quantity 1: if any money total leaked into the summary, it
    // would equal the unit price exactly — the sharpest version of the threat.
    const created = await postOrder(server(), buyer, { warehouse_id: warehouse, items: [{ product_id: product, quantity: 1 }] });
    expect(created.status).toBe(201);

    await relay.pollOnce();

    const rows = await withDb((pg) =>
      pg.query("SELECT summary FROM commerce.audit_log WHERE event_type = 'order.created' AND aggregate_id = $1", [
        created.body.data.id,
      ]),
    );
    expect(rows.rows).toHaveLength(1);
    const summary = rows.rows[0].summary;

    const keys = new Set<string>();
    collectKeys(summary, keys);
    expect(keys.has('unit_price')).toBe(false);
    expect(keys.has('price_list_item_id')).toBe(false);
    expect(keys.has('total')).toBe(false);
    expect(keys.has('subtotal')).toBe(false);
    expect(keys.has('line_total')).toBe(false);

    // No decimal-money-shaped value anywhere in the tree, regardless of key name —
    // the spec's keep-list is status, timestamps, quantities, never an amount.
    const values: unknown[] = [];
    collectValues(summary, values);
    const moneyShaped = values.filter((v) => typeof v === 'string' && MONEY_SHAPED.test(v));
    expect(moneyShaped).toEqual([]);

    // What it does keep, so the redaction is not accidentally over-broad.
    expect(summary).toMatchObject({
      order_id: created.body.data.id,
      buyer_org_id: t.buyerA,
      items: [{ product_id: product, sku: 'SKU-1', quantity: 1 }],
    });
  });
});
