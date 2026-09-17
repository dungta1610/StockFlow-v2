import type { Client } from 'pg';
import { Money } from '../modules/pricing/domain/money';

/**
 * Demo catalog: office supplies in two warehouses, a default price list and one
 * contract list per buyer. The two contracts price overlapping SKUs differently and
 * have quantity tiers, so a quote shows at a glance which customer it is for.
 */
export const SEED_PRODUCTS: { sku: string; name: string; uom: string; basePrice: string }[] = [
  { sku: 'PAPER-A4-70', name: 'Giấy A4 Double A 70gsm (ram 500 tờ)', uom: 'ream', basePrice: '72000' },
  { sku: 'PAPER-A4-80', name: 'Giấy A4 IK Plus 80gsm (ram 500 tờ)', uom: 'ream', basePrice: '85000' },
  { sku: 'PAPER-A3-70', name: 'Giấy A3 Double A 70gsm (ram 500 tờ)', uom: 'ream', basePrice: '145000' },
  { sku: 'PEN-TL-027', name: 'Bút bi Thiên Long TL-027 (hộp 20)', uom: 'box', basePrice: '70000' },
  { sku: 'PEN-GEL-B01', name: 'Bút gel Thiên Long GEL-B01 (hộp 10)', uom: 'box', basePrice: '55000' },
  { sku: 'PEN-HL-03', name: 'Bút dạ quang HL-03 (hộp 10)', uom: 'box', basePrice: '60000' },
  { sku: 'MARKER-WB-02', name: 'Bút lông bảng WB-02 (hộp 10)', uom: 'box', basePrice: '95000' },
  { sku: 'NOTE-3X3', name: 'Giấy nhớ 3x3 inch (xấp 100 tờ)', uom: 'pack', basePrice: '12000' },
  { sku: 'NOTEBOOK-A5', name: 'Sổ lò xo A5 200 trang', uom: 'each', basePrice: '35000' },
  { sku: 'FOLDER-L-A4', name: 'Bìa lá A4 (túi 10 cái)', uom: 'pack', basePrice: '25000' },
  { sku: 'BINDER-7CM', name: 'Bìa còng 7cm Kingstar', uom: 'each', basePrice: '48000' },
  { sku: 'STAPLER-10', name: 'Dập ghim số 10 Plus', uom: 'each', basePrice: '42000' },
  { sku: 'STAPLES-10', name: 'Ghim bấm số 10 (hộp 1000)', uom: 'box', basePrice: '5000' },
  { sku: 'CLIP-32MM', name: 'Kẹp bướm 32mm (hộp 12)', uom: 'box', basePrice: '18000' },
  { sku: 'TAPE-OPP-48', name: 'Băng keo trong 4.8cm (cây 6 cuộn)', uom: 'pack', basePrice: '78000' },
  { sku: 'GLUE-STICK', name: 'Hồ khô 21g', uom: 'each', basePrice: '15000' },
  { sku: 'SCISSORS-M', name: 'Kéo văn phòng cỡ vừa', uom: 'each', basePrice: '28000' },
  { sku: 'CALC-CASIO-12', name: 'Máy tính Casio 12 số', uom: 'each', basePrice: '320000' },
  { sku: 'INK-HP-680', name: 'Hộp mực HP 680 đen', uom: 'each', basePrice: '290000' },
  { sku: 'TONER-CAN-337', name: 'Hộp mực laser Canon 337', uom: 'each', basePrice: '1450000' },
];

export const SEED_WAREHOUSES = [
  { code: 'HN-01', name: 'Kho Hà Nội', address: 'KCN Quang Minh, Mê Linh, Hà Nội' },
  { code: 'HCM-01', name: 'Kho TP. Hồ Chí Minh', address: 'KCN Tân Bình, TP. Hồ Chí Minh' },
];

interface SeedList {
  name: string;
  orgCode: 'BUYER-A' | 'BUYER-B' | null;
  priority: number;
  skus: string[];
  /** Every listed SKU gets these tiers, priced as a percentage of its base price. */
  tiers: { minQty: number; percent: number }[];
}

export const SEED_PRICE_LISTS: SeedList[] = [
  {
    name: 'Bảng giá chuẩn 2026',
    orgCode: null,
    priority: 0,
    skus: SEED_PRODUCTS.map((p) => p.sku),
    tiers: [
      { minQty: 1, percent: 95 },
      { minQty: 100, percent: 92 },
    ],
  },
  {
    name: 'Hợp đồng An Phát 2026',
    orgCode: 'BUYER-A',
    priority: 10,
    skus: SEED_PRODUCTS.slice(0, 12).map((p) => p.sku),
    tiers: [
      { minQty: 1, percent: 90 },
      { minQty: 50, percent: 86 },
      { minQty: 200, percent: 82 },
    ],
  },
  {
    name: 'Hợp đồng Bình Minh 2026',
    orgCode: 'BUYER-B',
    priority: 10,
    skus: SEED_PRODUCTS.slice(6, 20).map((p) => p.sku),
    tiers: [
      { minQty: 1, percent: 88 },
      { minQty: 100, percent: 80 },
    ],
  },
];

/** `percent`% of `base`, rounded half-up to the nearest 100 đồng. */
function priceAt(base: string, percent: number): string {
  const hundreds = (Money.parse(base).minor * BigInt(percent) + 500_000n) / 1_000_000n;
  return Money.fromMinor(hundreds * 10_000n).toString();
}

/**
 * Opening stock, so the ops console and the copilot have something to look at.
 * Every row is paired with a ledger entry: no path may change stock without one.
 * HN-01 carries the bulk; HCM-01 keeps less, and the last SKU is deliberately out
 * of stock there.
 */
async function seedStock(
  pg: Client,
  productIds: ReadonlyMap<string, string>,
  createdBy: string | null,
): Promise<void> {
  const warehouseIds = new Map<string, string>();
  for (const w of SEED_WAREHOUSES) {
    const { rows } = await pg.query<{ id: string }>('SELECT id FROM commerce.warehouses WHERE code = $1', [
      w.code,
    ]);
    warehouseIds.set(w.code, rows[0]!.id);
  }

  for (const [index, p] of SEED_PRODUCTS.entries()) {
    const quantities = { 'HN-01': 200 + index * 10, 'HCM-01': index === SEED_PRODUCTS.length - 1 ? 0 : 60 };
    for (const [code, quantity] of Object.entries(quantities)) {
      const inserted = await pg.query<{ id: string }>(
        `INSERT INTO commerce.inventory (product_id, warehouse_id, available_qty, version)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (product_id, warehouse_id) DO NOTHING
         RETURNING id`,
        [productIds.get(p.sku), warehouseIds.get(code), quantity],
      );
      const inventoryId = inserted.rows[0]?.id;
      if (inventoryId === undefined || quantity === 0) continue;
      await pg.query(
        `INSERT INTO commerce.inventory_transactions
           (inventory_id, product_id, warehouse_id, txn_type, quantity,
            before_available_qty, after_available_qty, before_reserved_qty, after_reserved_qty,
            reason, created_by)
         VALUES ($1, $2, $3, 'manual_adjustment', $4, 0, $4, 0, 0, 'tồn kho đầu kỳ', $5)`,
        [inventoryId, productIds.get(p.sku), warehouseIds.get(code), quantity, createdBy],
      );
    }
  }
}

export async function seedCatalog(
  pg: Client,
  orgIds: ReadonlyMap<string, { id: string }>,
  opsAdminId: string | null,
): Promise<void> {
  const productIds = new Map<string, string>();
  for (const p of SEED_PRODUCTS) {
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO commerce.products (sku, name, uom, base_price) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [p.sku, p.name, p.uom, p.basePrice],
    );
    productIds.set(p.sku, rows[0]!.id);
  }

  for (const w of SEED_WAREHOUSES) {
    await pg.query(
      `INSERT INTO commerce.warehouses (code, name, address) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO NOTHING`,
      [w.code, w.name, w.address],
    );
  }

  const basePrices = new Map(SEED_PRODUCTS.map((p) => [p.sku, p.basePrice]));
  for (const l of SEED_PRICE_LISTS) {
    const orgId = l.orgCode === null ? null : orgIds.get(l.orgCode)!.id;
    // Price lists have no natural key; the seed recognises its own by name and owner.
    const existing = await pg.query<{ id: string }>(
      `SELECT id FROM commerce.price_lists WHERE name = $1 AND org_id IS NOT DISTINCT FROM $2`,
      [l.name, orgId],
    );
    const listId =
      existing.rows[0]?.id ??
      (
        await pg.query<{ id: string }>(
          `INSERT INTO commerce.price_lists (org_id, org_type, name, valid_from, priority)
           VALUES ($1, CASE WHEN $1::uuid IS NULL THEN NULL ELSE 'buyer' END, $2, '2026-01-01T00:00:00+07:00', $3)
           RETURNING id`,
          [orgId, l.name, l.priority],
        )
      ).rows[0]!.id;

    for (const sku of l.skus) {
      for (const t of l.tiers) {
        await pg.query(
          `INSERT INTO commerce.price_list_items (price_list_id, product_id, min_qty, unit_price)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (price_list_id, product_id, min_qty) DO NOTHING`,
          [listId, productIds.get(sku), t.minQty, priceAt(basePrices.get(sku)!, t.percent)],
        );
      }
    }
  }

  await seedStock(pg, productIds, opsAdminId);
}
