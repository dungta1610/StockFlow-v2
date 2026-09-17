---
phase: 2
title: "Catalog, Warehouse & Pricing"
status: completed
priority: P1
dependencies: [1]
---

# Phase 02: Catalog, Warehouse & Pricing

> **Sửa sau red-team (finding #13 + YAGNI + một-currency).** Bỏ `ChainPriceResolver` và 3 class resolver — chúng mâu thuẫn trực tiếp với chính gate "đúng 1 query" nằm ngay bên cạnh, vì `base_price` ở bảng khác. Giữ **port** (seam thật), thay chain bằng 1 repository method + 1 hàm thuần. Gộp `warehouse` vào `catalog`. Khoá **một currency** cho v1.

## Overview

Chương 2 — **Pricing as policy engine**. Port `product` + `warehouse` từ repo Go, thêm **bảng giá theo từng khách có bậc số lượng** — đặc trưng B2B rõ nhất, đồng thời vá lỗ hổng #3 (client tự quyết giá) và #4 (float money) của repo cũ.

## Requirements

**Functional**
- Product: create / get / list / update. Giữ `Filter.Normalize()` (SKU uppercase, trim).
- Warehouse: create / get / list / update. **Nằm trong `modules/catalog`**, không phải module riêng.
- **Lookup theo mã**: `findProductBySku`, `findWarehouseByCode` — Phase 08 tool cần (`getStatus({sku, warehouseCode})`).
- Price list gắn với một org (hoặc `org_id NULL` = mặc định), có khoảng hiệu lực, độ ưu tiên, `status`.
- Price list item `(price_list_id, product_id, unit_price, min_qty)`; bậc số lượng = nhiều row khác `min_qty`.
- `PriceResolver.resolve(scope, customerOrgId, items, at)` trả giá **và nguồn giá**.

**Non-functional**
- Tiền: `numeric(18,2)` ở DB, integer minor-units trong app. Không float ở đâu, **kể cả `apps/web` và `packages/contracts`**.
- **Một currency toàn hệ thống v1** (`VND`), validate ở biên. Multi-currency v1.1.
- Resolve **≤ 2 query, và số query không đổi theo kích thước giỏ** — Phase 04 gọi trong transaction.
- Resolver **deterministic**: cùng input ⇒ cùng output, không phụ thuộc thứ tự row DB trả.

## Architecture

```
modules/catalog/                 # product + warehouse (gộp — finding YAGNI)
├── domain/          product.ts · warehouse.ts · sku.ts (VO) · errors.ts
├── application/     ports/{product.repository.ts, warehouse.repository.ts}
│                    use-cases/{create,get,list,update}-{product,warehouse}.ts
│                    catalog.service.ts       ← bề mặt cho Phase 08
├── infrastructure/  sql-product.repository.ts · sql-warehouse.repository.ts
└── http/            product.controller.ts · warehouse.controller.ts

modules/pricing/
├── domain/          price-list.ts · price-list-item.ts · money.ts (VO)
│                    resolved-price.ts · pick-price.ts  ← hàm THUẦN
│                    errors.ts
├── application/     ports/{price-list.repository.ts, price-resolver.ts}
│                    sql-price-resolver.ts    ← một implementation
│                    use-cases/{create-price-list,add-items,resolve-prices}.ts
├── infrastructure/  sql-price-list.repository.ts
└── http/            price-list.controller.ts
```

### Vì sao bỏ chain — sửa finding #13 (D4)

Plan đầu: 3 resolver chạy tuần tự, dừng ở cái đầu tiên có giá. Nhưng `BasePriceResolver` đọc `products.base_price` — **bảng khác** với `price_list_items ⋈ price_lists`. Nên sản phẩm không nằm trong bảng giá nào bắt buộc query thứ hai, trong khi test #7 lại assert **đúng 1** query. Hai thứ cạnh nhau không thể cùng đúng. Dưới áp lực, một trong hai sẽ bị bẻ: hoặc gộp thành `LEFT JOIN LATERAL` (giết luôn tính chất "thêm resolver = không sửa `ordering`"), hoặc nới test thành "≤3" (mất khả năng bắt N+1 thật ở Phase 04).

Giữ cái có giá trị, bỏ cái chỉ trông có vẻ có giá trị:

```ts
// port — ĐÂY mới là seam mở rộng thật
export interface PriceResolver {
  resolve(scope: OrgScope, customerOrgId: string,
          items: { productId: string; qty: number }[], at: Date)
    : Promise<Map<string, ResolvedPrice>>
}
export interface ResolvedPrice {
  unitPrice: Money
  sourceKind: 'contract' | 'default_list' | 'base_price'
  sourceId: string | null        // price_list_item_id, null nếu base_price
  minQtyApplied: number          // bậc đang áp — giải thích được cho người dùng
}

// hàm THUẦN, test không cần DB
export function pickPrice(candidates: PriceCandidate[], qty: number, at: Date): Pick
```

`SqlPriceResolver` chạy **2 query**: (1) mọi candidate từ price list cho cả danh sách product, (2) `base_price` cho product nào không có candidate. Rồi `pickPrice` làm bậc số lượng + tie-break trong bộ nhớ. Số query **không đổi** dù giỏ 3 hay 200 item.

Thêm promotion/campaign sau này = thêm implementation của **port**, hoặc thêm một nguồn candidate vào query (1). Không đụng `modules/ordering`. Tính chất mở rộng được giữ nguyên, chi phí bớt 5 file.

### Quy tắc chọn giá (thuần, trong `pickPrice`)

1. Lọc candidate: `price_lists.status='active'` **và** `valid_from <= at` **và** (`valid_to` null hoặc `> at`).
2. Chọn bảng giá: `org_id = customerOrgId` ưu tiên hơn `org_id IS NULL`; rồi `priority DESC`; rồi `valid_from DESC`; rồi `id ASC`.
3. Trong bảng đã chọn: row có `min_qty` **lớn nhất mà ≤ qty**.
4. Không có candidate nào ⇒ `base_price`, `sourceId = null`, `minQtyApplied = 1`.

Tie-break đi đến `id ASC` ⇒ không thể hoà ⇒ deterministic tuyệt đối.

`price_lists.status` tham gia bước 1 — plan đầu khai cột rồi không bao giờ dùng.

### Schema (migration `003_catalog.sql`, `004_pricing.sql`)

```sql
-- 003: port từ StockFlow/module/{product,warehouse}/storage/*.go
products(
  id uuid pk, sku text unique not null, name text not null,
  description text not null default '', base_price numeric(18,2) not null,
  currency char(3) not null default 'VND'
    check (currency = 'VND'),            -- một currency v1; nới khi làm multi-currency
  uom text not null default 'each',
  is_active boolean not null default true, created_at, updated_at)

warehouses(
  id uuid pk, code text unique not null, name text not null,
  address text not null default '', is_active boolean not null default true,
  created_at, updated_at)

-- 004
price_lists(
  id uuid pk, org_id uuid null references organizations(id),  -- NULL = mặc định
  name text not null, currency char(3) not null check (currency = 'VND'),
  valid_from timestamptz not null, valid_to timestamptz,
  priority int not null default 0,
  status text not null default 'active' check (status in ('active','archived')),
  created_at, updated_at)

price_list_items(
  id uuid pk, price_list_id uuid references price_lists(id),
  product_id uuid references products(id),
  unit_price numeric(18,2) not null check (unit_price >= 0),
  min_qty int not null default 1 check (min_qty >= 1),
  created_at, updated_at,
  unique (price_list_id, product_id, min_qty))

create index on price_list_items (product_id, price_list_id, min_qty desc);
create index on price_lists (org_id, status, valid_from desc);
```

`check (currency = 'VND')` là cách trung thực nhất để nói "v1 một currency": nó **chặn** dữ liệu sai thay vì để `Money.add` ném lỗi giữa transaction. Làm multi-currency = bỏ check + thêm bảng exponent + tham số scale. Nửa vời là lựa chọn tệ nhất — red-team nói đúng.

## Related Code Files

**Create**
- `db/migrations/003_catalog.sql`, `db/migrations/004_pricing.sql`
- `apps/api/src/modules/catalog/**`, `apps/api/src/modules/pricing/**`
- `packages/contracts/src/{catalog.ts,pricing.ts}`
- `docs/adr/0010-money-as-minor-units-single-currency.md`
- `docs/adr/0011-price-resolver-port-without-chain.md`

**Modify**
- `apps/api/src/app.module.ts`
- `scripts/seed.ts` — **20 SKU**, 2 warehouse, 1 bảng giá mặc định + 2 bảng hợp đồng khác nhau rõ rệt, có bậc số lượng
- `docs/code-standards.md` — rule tiền + một currency

**Reference (read-only)**
- `StockFlow/module/product/{model/product.go,biz/*.go,storage/sql_product.go,transport/gin/*.go}`
- `StockFlow/module/warehouse/{model/warehouse.go,biz/*.go,storage/sql_warehouse.go}`
- `StockFlow/module/*/model/paging.go`
- **Lưu ý:** repo Go **không có** `update_product.go`/`update_warehouse.go` ở `biz/` hay handler (chỉ có model `ProductUpdate` không ai dùng). Update là **thêm mới**, không phải port.

## Tests First (TDD — nghiêm)

1. `pricing/money.spec.ts` — `fromDecimalString('1234.56')` round-trip không mất chính xác; `multiply(3)` đúng; không đường nào nhận `number` thập phân.
2. `pricing/pick-price.spec.ts` — **hàm thuần, không DB.** Bậc `{1:50000, 50:45000, 200:40000}`: qty 1⇒50000, 49⇒50000, 50⇒45000, 199⇒45000, 200⇒40000, 1000⇒40000. `minQtyApplied` đúng ở mỗi mốc.
3. `pricing/pick-price-selection.spec.ts` — thuần: bảng org ưu tiên hơn bảng mặc định; `status='archived'` bị loại; `valid_to` đã qua bị loại; `valid_from` tương lai bị loại.
4. `pricing/determinism.spec.ts` — thuần: hai bảng cùng `priority` **và** cùng `valid_from` ⇒ vẫn một kết quả, lặp 50 lần không đổi.
5. `pricing/resolver-source-kind.spec.ts` — org có bảng hợp đồng ⇒ `contract`; không có ⇒ `default_list`; product ngoài mọi bảng ⇒ `base_price`, `sourceId=null`.
6. **`pricing/query-count.spec.ts`** — resolve 3 item và resolve 20 item ⇒ **cùng số query**, và **≤ 2**. *(Thay cho gate "đúng 1" bất khả thi.)*
7. **`pricing/scope.spec.ts`** — `single` scope của org A resolve cho `customerOrgId=B` ⇒ ném lỗi; `all-buyers` (ops) resolve cho B ⇒ ok; `all-buyers` cho org **internal** ⇒ ném lỗi.
8. `pricing/tenant-isolation.spec.ts` — resolve cho org A không bao giờ trả giá từ bảng của org B, kể cả khi B priority cao hơn.
9. `catalog/product.spec.ts` — CRUD + normalize (SKU uppercase, trim) + SKU trùng ⇒ lỗi rõ ràng.
10. `catalog/warehouse.spec.ts` — CRUD + normalize code.
11. **`catalog/lookup-by-code.spec.ts`** — `findProductBySku('abc')` khớp `ABC`; `findWarehouseByCode` tương tự; không thấy ⇒ null, không ném.
12. **`pricing/currency-guard.spec.ts`** — INSERT product/price_list currency ≠ `VND` ⇒ **DB từ chối**.

## Implementation Steps

1. Migration 003 + 004.
2. Viết 12 test ở §Tests First — đỏ.
3. `Money` VO + cấu hình `pg` **không** parse `numeric` thành float. ADR 0010 ngay (quyết định này ảnh hưởng mọi phase sau).
4. `pick-price.ts` — hàm thuần. Test #2, #3, #4 xanh **không cần DB**. Làm trước vì đây là toàn bộ logic giá.
5. Port `catalog`: product + warehouse từ Go, giữ `Filter.Normalize()`, `Price float64` → `Money`. Thêm lookup theo SKU/code (Phase 08 cần). Test #9, #10, #11 xanh.
6. `SqlPriceListRepository.findCandidates(customerOrgId, productIds, at)` — **một query** trả mọi candidate kèm đủ cột để xếp hạng ở tầng application. Không xếp hạng trong SQL ⇒ logic ở một chỗ, test được không cần DB.
7. `SqlPriceResolver` — query (1) candidate, query (2) `base_price` cho phần còn thiếu, rồi `pickPrice`. Gọi `assertOrgInScope(scope, customerOrgId)` **đầu tiên**. Test #5, #6, #7, #8 xanh.
8. `http/`: controller product/warehouse/price-list.
9. Seed: 20 SKU, 2 warehouse, 1 bảng mặc định, 2 bảng hợp đồng chênh nhau rõ (Phase 08 cần để so sánh được).
10. Test xanh. ADR 0011.

## Success Criteria

- [x] 12 test ở §Tests First xanh (gom thành 7 file, xem bảng dưới).
- [x] Resolve 1 item và 20 item tốn **cùng** số query, và ≤ 2.
- [x] Buyer org A thấy giá của A; org B thấy giá của B; khác nhau thật trong seed.
- [x] Ops resolve được giá cho bất kỳ buyer org nào; buyer không resolve được cho org khác.
- [x] Product ngoài mọi bảng giá ⇒ `base_price`, không ném lỗi.
- [x] `grep -rniE "(price|amount|total|subtotal)\s*:\s*number" apps/api/src packages/*/src apps/web/src` ⇒ rỗng.
- [x] DB từ chối currency ≠ `VND`.
- [x] Không có file nào tên `chain-price-resolver.ts` (chain đã bỏ).
- [x] ADR 0010, 0011 tồn tại; 0011 nêu rõ vì sao port ở lại mà chain thì không.

## Thực tế đã build (2026-09-18)

| Hạng mục | Kết quả |
|---|---|
| Migration | `003_catalog.sql` (products, warehouses; CHECK code đã normalize), `004_pricing.sql` (price_lists với FK tổng hợp `(org_id, org_type)` → chỉ buyer có bảng hợp đồng; `chk_price_list_validity`) |
| Catalog | `modules/catalog` — product + warehouse CRUD (create/get/list/update), `CatalogService` (`findProductBySku`, `findWarehouseByCode`, `findProducts`, `findWarehouse`) là bề mặt duy nhất cho module khác |
| Pricing | `Money` (bigint minor units), `pickPrice` thuần, port `PriceResolver` + `SqlPriceResolver` (2 query), price-list CRUD + upsert tier + archive, `POST /pricing/quote` |
| API | `/products`, `/warehouses` (đọc: mọi user; ghi: ops_admin) · `/price-lists` (đọc: ops; ghi: ops_admin; buyer 403) · `POST /pricing/quote` (buyer: org mình; ops: bắt buộc `customer_org_id`) |
| Seed | 20 SKU văn phòng phẩm, 2 kho (HN-01, HCM-01), bảng chuẩn (95%/92% từ 100), An Phát (90/86/82%), Bình Minh (88/80%) — idempotent |
| Test | `money`, `pick-price`, `price-resolver`, `pricing-constraints`, `pricing-api`, `products-api`, `warehouses-api`, seed mở rộng — toàn bộ 271+ test xanh |
| Docs | ADR 0010, 0011; `code-standards.md` §Money |

**Sau review (2026-09-18):** sửa lỗi id sản phẩm viết hoa bị báo `PRODUCT_NOT_FOUND` (contracts chuẩn hoá UUID về chữ thường; resolver/use case chuẩn hoá lại); đọc price list có `OrgScope`; `Money.parse` ném `400 INVALID_AMOUNT`; tier `min_qty < 1`/trùng ở tầng use case ⇒ 400; buyer không thấy sản phẩm ngưng bán; seed dùng chuỗi tiền; grep gate không phân biệt hoa thường. Quyết định: dòng đơn hàng (Phase 04) **chép** đơn giá, `price_list_item_id` chỉ để truy vết. Chưa sửa (Low, ghi nhận): `Money` nằm trong pricing nên catalog import ngược; identity export cả `OrganizationRepository`; `Money.times` chưa chặn vượt `numeric(18,2)` — xử lý ở Phase 04 khi lưu tổng đơn. Báo cáo: `reports/code-reviewer-260918-phase-02-catalog-pricing-review.md`.

**Lệch so với spec (có chủ đích, ghi trong ADR 0011):** resolver trả mảng theo thứ tự request thay vì `Map`; nhận `customer {id, type}` và `Tx` tường minh; product không tồn tại/ngưng bán ⇒ lỗi cả request; `price` của Go đổi tên thành `base_price`; bảng giá chỉ archive, không xoá; query 1 là products (qua `CatalogService`), query 2 là tier.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| `pg` tự parse `numeric` thành float | Test #1 round-trip bắt ngay; cấu hình parser tường minh ở bước 3 |
| Bỏ chain rồi mất tính mở rộng | Port ở lại — đó mới là seam. Chứng minh ở Phase 11: thêm implementation mới không đụng `modules/ordering` |
| N+1 lọt vào Phase 04 | Test #6 so **số query giữa giỏ 3 và giỏ 20**, mạnh hơn gate "đúng 1" cũ và không thể thoả mãn bằng cách gian |
| Bậc số lượng hiểu sai | Test #2 liệt kê đủ biên 1/49/50/199/200/1000 trước khi viết code |
| Tie-break không xác định | Test #4 lặp 50 lần; tie-break đi đến `id ASC` |
| Một currency thành ràng buộc phiền sau này | Ràng buộc nằm ở `CHECK` — nới là một migration. Rẻ hơn nhiều so với multi-currency nửa vời |
