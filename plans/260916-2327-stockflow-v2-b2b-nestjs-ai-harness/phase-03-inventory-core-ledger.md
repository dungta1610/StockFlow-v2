---
phase: 3
title: "Inventory Core & Ledger"
status: completed
priority: P1
dependencies: [2]
---

# Phase 03: Inventory Core & Ledger

> **Sửa sau red-team (finding #13, #5, #2 + race adjust-stock).** Ba hợp đồng `reserveAtomic`/`releaseAtomic`/`consumeAtomic` nay có **chữ ký đầy đủ và hợp đồng null tường minh** — plan đầu chỉ đặt tên hai cái sau rồi để Phase 04 tự đoán. Mọi use case nhận `tx: Tx`. `getStatus` nhận SKU/warehouse code vì Phase 08 gọi như vậy.

## Overview

Chương 1, phần 1 — **Concurrency & transaction**. Port `inventory` từ repo Go và lần đầu chạm tranh chấp đồng thời thật. Sổ cái `inventory_transactions` thiết lập ở đây; Phase 04 ghi vào nó trong cùng transaction với việc giữ hàng.

## Requirements

**Functional**
- `POST /inventories/adjust` — cộng/trừ tồn, ghi sổ cái, tự tạo row nếu chưa có (đúng hành vi repo Go).
- `GET /inventories/detail`, `GET /inventories`, `GET /inventories/transactions`.
- `InventoryService.getStatus(scope, { sku, warehouseCode? })` và `LedgerService.history(scope, ...)` — bề mặt Phase 08 gọi, **nhận mã chứ không nhận uuid**.
- Ba primitive nguyên tử cho Phase 04: `reserveAtomic`, `releaseAtomic`, `consumeAtomic`.

**Non-functional**
- `inventory_transactions` **append-only**: repository không có method update/delete.
- Mọi thay đổi `inventory` **bắt buộc** ghi một row sổ cái trong cùng transaction.
- Adjust chỉ `ops`/`ops_admin`.
- Mọi use case nhận `tx: Tx` (D3) — không tự mở transaction.

## Architecture

```
modules/inventory/
├── domain/          inventory.ts · inventory-transaction.ts · txn-type.ts
│                    stock-level.ts (VO) · errors.ts
├── application/     ports/{inventory.repository.ts, ledger.repository.ts}
│                    use-cases/{adjust-stock,get-inventory,list-inventory,
│                               list-transactions}.ts
│                    inventory.service.ts      ← bề mặt Phase 08
│                    ledger.service.ts         ← bề mặt Phase 08
├── infrastructure/  sql-inventory.repository.ts · sql-ledger.repository.ts
└── http/            inventory.controller.ts · dto/
```

### Ba primitive nguyên tử — hợp đồng đầy đủ (sửa finding #13)

```ts
export interface StockLevel { available: number; reserved: number }
export interface StockMove {
  inventoryId: string
  before: StockLevel
  after: StockLevel
}

export interface InventoryRepository {
  /** available -= qty, reserved += qty. null nếu không đủ hàng (0 row affected). */
  reserveAtomic(tx: Tx, productId: string, warehouseId: string, qty: number)
    : Promise<StockMove | null>

  /** available += qty, reserved -= qty. null nếu reserved < qty (dữ liệu đã lệch). */
  releaseAtomic(tx: Tx, inventoryId: string, qty: number): Promise<StockMove | null>

  /** reserved -= qty, available KHÔNG đổi (hàng đã rời kho). null nếu reserved < qty. */
  consumeAtomic(tx: Tx, inventoryId: string, qty: number): Promise<StockMove | null>
  // … findByProductAndWarehouse, lockForUpdate, create, updateAvailable
}
```

**Hợp đồng null là một phần của API**, không phải chi tiết cài đặt: `null` nghĩa là "điều kiện không thoả, **không có gì thay đổi**". Phase 04 dựa vào đúng tính chất đó để rollback đúng. Plan đầu để trống chỗ này nên Phase 04 không có gì để dựa vào.

`release`/`consume` nhận `inventoryId` (không phải cặp product/warehouse) vì Phase 04 đã có id từ `inventory_reservations` — bớt một lần tra.

### Hai cơ chế ghi, dùng đúng chỗ

| Thao tác | Cơ chế | Vì sao |
|---|---|---|
| Adjust stock (ops nhập/xuất tay) | `INSERT … ON CONFLICT DO UPDATE … RETURNING` | Cần `before_*` để ghi sổ cái, và row có thể chưa tồn tại |
| Reserve / release / consume | **Conditional UPDATE … RETURNING** | Không cần đọc trước; `RETURNING` trả luôn before/after; 0 row = điều kiện không thoả |

**Sửa race ở adjust:** repo Go dùng `SELECT … FOR UPDATE` rồi tạo row nếu `ErrNoRows`. `FOR UPDATE` trên row **không tồn tại** không khoá gì cả — hai adjust đồng thời cho cặp mới sẽ đua nhau INSERT, một cái nhận `23505` hoặc một lần adjust mất trắng kèm thiếu row sổ cái. Thay bằng upsert nguyên tử:

```sql
INSERT INTO inventory (product_id, warehouse_id, available_qty, reserved_qty, version)
VALUES ($p, $w, GREATEST($delta, 0), 0, 1)
ON CONFLICT (product_id, warehouse_id) DO UPDATE
   SET available_qty = inventory.available_qty + $delta,
       version       = inventory.version + 1,
       updated_at    = now()
 WHERE inventory.available_qty + $delta >= 0
RETURNING id, available_qty, reserved_qty,
          available_qty - $delta AS before_available, reserved_qty AS before_reserved;
```
0 row ⇒ không đủ hàng (hoặc delta âm trên row mới) ⇒ `NOT_ENOUGH_STOCK`. Một statement, không race, before/after có luôn để ghi sổ cái.

Reserve giữ nguyên hình dạng đã thiết kế:
```sql
UPDATE inventory
   SET available_qty = available_qty - $q, reserved_qty = reserved_qty + $q,
       version = version + 1, updated_at = now()
 WHERE product_id = $p AND warehouse_id = $w AND available_qty >= $q
RETURNING id, available_qty, reserved_qty,
          available_qty + $q AS before_available, reserved_qty - $q AS before_reserved;
```

### Schema (migration `005_inventory.sql`)

Tái dựng từ `StockFlow/module/inventory/storage/*.go` — red-team đã verify khớp từng cột.

```sql
inventory(
  id uuid pk,
  product_id uuid not null references products(id),
  warehouse_id uuid not null references warehouses(id),
  available_qty int not null default 0,
  reserved_qty  int not null default 0,
  version int not null default 1,
  created_at, updated_at,
  unique (product_id, warehouse_id),
  check (available_qty >= 0),
  check (reserved_qty  >= 0))

inventory_transactions(
  id uuid pk,
  inventory_id uuid not null references inventory(id),
  product_id   uuid not null references products(id),
  warehouse_id uuid not null references warehouses(id),
  order_id       uuid null,        -- FK thêm ở Phase 04 (tránh phụ thuộc vòng)
  reservation_id uuid null,
  txn_type text not null
    check (txn_type in ('manual_adjustment','reserve','release','consume')),
  quantity int not null check (quantity > 0),
  before_available_qty int not null, after_available_qty int not null,
  before_reserved_qty  int not null, after_reserved_qty  int not null,
  reason text not null default '',
  created_by uuid null references users(id),
  created_at timestamptz not null default now())

create index on inventory_transactions (inventory_id, created_at desc);
create index on inventory_transactions (order_id) where order_id is not null;
```

Hai `CHECK >= 0` là **lưới an toàn cuối**: logic đã ngăn số âm, ràng buộc DB đảm bảo kể cả khi logic sai thì dữ liệu không hỏng. Repo Go thiếu cả hai.

**Ghi chú về `version`:** repo Go tăng nó nhưng không bao giờ dùng làm lock predicate. Ta giữ để audit và cho các đường read-modify-write tương lai, và **ghi rõ trong ADR rằng v1 không dùng nó làm optimistic lock** — không để nó trở thành cargo cult.

## Related Code Files

**Create**
- `db/migrations/005_inventory.sql`
- `apps/api/src/modules/inventory/**`
- `packages/contracts/src/inventory.ts`
- `docs/adr/0012-two-write-mechanisms-for-inventory.md`

**Modify**
- `apps/api/src/app.module.ts`
- `scripts/seed.ts` — tồn kho ban đầu 20 SKU × 2 warehouse
- `docs/code-standards.md` — "ledger append-only" + "mọi thay đổi inventory phải ghi sổ cái cùng tx"

**Reference (read-only)**
- `StockFlow/module/inventory/model/{inventory.go,inventory_transaction.go,inventory_reservation.go,errors.go}`
- `StockFlow/module/inventory/storage/{sql_inventory.go,sql_inventory_transaction.go,sql_inventory_reservation.go}` — **nguồn sự thật cho schema**
- `StockFlow/module/inventory/biz/{adjust_stock.go,get_inventory.go,list_inventory_transactions.go}`

## Tests First (TDD — nghiêm)

1. `inventory/adjust-creates-row.spec.ts` — adjust `+100` cho cặp chưa có ⇒ tạo row `available_qty=100`, và **một** row sổ cái `before_available=0, after_available=100`.
2. `inventory/adjust-negative-guard.spec.ts` — adjust `-10` khi chưa tồn tại ⇒ `NOT_ENOUGH_STOCK`, không tạo row. Adjust `-150` khi có 100 ⇒ lỗi, tồn kho không đổi, không row sổ cái mới.
3. **`inventory/adjust-concurrent-create.spec.ts`** — 10 adjust `+10` **song song** cho cặp **chưa tồn tại** ⇒ đúng một row inventory, `available_qty=100`, **10** row sổ cái, không lỗi `23505`. *(Race mà repo Go có.)*
4. `inventory/ledger-is-mandatory.spec.ts` — sau mỗi adjust thành công, số row sổ cái tăng đúng 1 và `after_available_qty` khớp `inventory.available_qty`.
5. `inventory/ledger-append-only.spec.ts` — `LedgerRepository` **không có** method update/delete (assert trên bề mặt interface).
6. **`inventory/reserve-atomic.spec.ts`** — qty ≤ available ⇒ `StockMove` với before/after đúng, tổng `available+reserved` không đổi. qty > available ⇒ **`null`, không đổi gì**.
7. **`inventory/release-consume-atomic.spec.ts`** — `releaseAtomic`: available tăng, reserved giảm. `consumeAtomic`: reserved giảm, **available không đổi**. Cả hai: `reserved < qty` ⇒ `null`, không đổi gì.
8. `inventory/reserve-concurrent.spec.ts` — 20 `reserveAtomic` song song 1 đơn vị trên tồn 10 ⇒ đúng 10 trả `StockMove`, 10 trả `null`, `available_qty=0`, không bao giờ âm.
9. `inventory/db-check-constraint.spec.ts` — `UPDATE inventory SET available_qty = -1` bằng SQL thô ⇒ DB từ chối.
10. `inventory/rbac.spec.ts` — role `buyer` gọi adjust ⇒ 403; `ops` ⇒ 200.
11. **`inventory/get-status-by-code.spec.ts`** — `getStatus(scope, {sku:'abc'})` khớp `ABC`, trả mọi kho; kèm `warehouseCode` ⇒ đúng một kho; SKU không tồn tại ⇒ lỗi rõ ràng, không mảng rỗng mơ hồ.

## Implementation Steps

1. **Đọc `StockFlow/module/inventory/storage/sql_inventory.go` và `sql_inventory_transaction.go`**, đối chiếu từng cột với migration 005. (Red-team đã verify khớp — vẫn đối chiếu lại khi viết.)
2. Migration `005_inventory.sql` gồm hai `CHECK`, `txn_type` check, index.
3. Viết 11 test ở §Tests First — đỏ.
4. `domain/`: `Inventory`, `InventoryTransaction`, `TxnType`, `StockLevel`, `StockMove`, `errors.ts`.
5. `ports/InventoryRepository` với **ba primitive đủ chữ ký ở §Architecture**; `ports/LedgerRepository` chỉ có `append` + method đọc.
6. `SqlInventoryRepository` — upsert nguyên tử cho adjust (sửa race), conditional UPDATE cho 3 primitive. Test #3, #6, #7, #8 xanh.
7. `AdjustStockUseCase(tx, actor, input)` — port từ `biz/adjust_stock.go`, thêm ghi sổ cái bắt buộc cùng tx + guard role ops.
8. `InventoryService` + `LedgerService` — nhận `scope: OrgScope` và **mã** (`sku`, `warehouseCode`), tra sang uuid qua `catalog`. Test #11 xanh.
9. `http/`: controller + DTO; controller mở `withTransaction` rồi truyền `tx` xuống use case.
10. Seed tồn kho. Test xanh. ADR 0012.

## Success Criteria

- [x] 11 test ở §Tests First xanh (gom thành 6 file, 31 test).
- [x] Test adjust song song trên cặp chưa tồn tại xanh — race của repo Go đã vá.
- [x] Test 20 reserve song song trên tồn 10 xanh (đúng 10 `StockMove`, 10 `null`, tồn về 0).
- [x] Ba primitive có chữ ký đầy đủ và hợp đồng `null` được test tường minh.
- [x] Migration 005 đối chiếu từng cột với `sql_inventory.go` / `sql_inventory_transaction.go`.
- [x] Không đường nào sửa `inventory` mà không ghi sổ cái (kể cả seed).
- [x] `LedgerRepository` chỉ có `append` + `list`.
- [x] `UPDATE inventory SET available_qty = -1` bị DB từ chối.
- [x] Không use case nào trong module tự gọi `withTransaction`.
- [x] ADR 0012 giải thích hai cơ chế ghi và vì sao `version` không phải optimistic lock.

## Thực tế đã build (2026-09-18)

| Hạng mục | Kết quả |
|---|---|
| Migration | `005_inventory.sql` — `inventory` (2 CHECK ≥ 0, unique product+warehouse), `inventory_transactions` 15 cột append-only, `order_id`/`reservation_id` chưa gắn FK (Phase 04 thêm) |
| Primitive | `adjustAtomic`, `reserveAtomic`, `releaseAtomic`, `consumeAtomic` — mỗi cái một câu lệnh có điều kiện, `RETURNING` trả before/after; `null` = không thoả điều kiện, không đổi gì. Chỉ gọi được qua `StockMovementService` |
| Bất biến sổ cái | `StockMovementService` là lối duy nhất để tồn kho thay đổi: nó ghi chuyển động **và** dòng sổ cái cùng lúc; repository không export khỏi module |
| Use case | `AdjustStockUseCase` (ops/ops_admin, ghi sổ cái cùng tx), `GetInventoryUseCase`, `ListInventoryUseCase`, `ListInventoryTransactionsUseCase` |
| Service | `InventoryService.getStatus(db, actor, {sku, warehouseCode?})`, `LedgerService.history(...)` — nhận mã, mã sai ⇒ 404 rõ ràng |
| API | `POST /inventories/adjust`, `GET /inventories`, `/inventories/detail`, `/inventories/transactions` — toàn bộ chỉ ops/ops_admin |
| Seed | Tồn đầu kỳ 20 SKU × 2 kho (HN-01 nhiều, HCM-01 ít, SKU cuối hết hàng ở HCM-01) kèm sổ cái |
| Test | 6 file inventory (31 test); toàn repo 306 test xanh |
| Docs | ADR 0012; `code-standards.md` §Ledger |

**Sau review (2026-09-18):** sửa 3 finding High — (1) adjust giảm tồn trên cặp chưa có row không còn tạo row rác không có sổ cái (chỉ khi tăng tồn mới INSERT); (2) ba primitive từ chối `qty <= 0` và số lẻ bằng `400 INVALID_QUANTITY` thay vì "thành công rỗng" hoặc làm hỏng transaction của caller; (3) bất biến "đổi tồn ⇒ ghi sổ cái" nay là ràng buộc cấu trúc qua `StockMovementService`. Thêm: `created_at` dùng `clock_timestamp()` để nhiều chuyển động trong một transaction xếp đúng thứ tự; `getStatus` đọc mọi kho thay vì một trang 100; thêm index `warehouse_id`, `reservation_id`; seed tra `created_by` theo email tường minh. Ghi nhận để Phase 04 xử lý: release/consume kiểm theo tổng `reserved_qty` (cần trạng thái reservation để idempotent) và thứ tự khoá để tránh deadlock đơn nhiều dòng. Báo cáo: `reports/code-reviewer-260918-phase-03-inventory-ledger-review.md`.

**Lệch so với spec (có chủ đích):**
- Adjust dùng **hai câu lệnh** (INSERT … ON CONFLICT DO NOTHING rồi UPDATE có điều kiện) thay vì một `INSERT … ON CONFLICT DO UPDATE`. Lý do trong ADR 0012: nhánh INSERT mang delta âm sẽ hoặc vi phạm CHECK (làm hỏng cả transaction của caller) hoặc tạo row rác. Cả hai câu lệnh đều an toàn khi chạy song song.
- Row mới bắt đầu `version = 0` để lần adjust đầu tiên đưa nó về 1 — một chuyển động, một version.
- `StockMove` mang thêm `productId`/`warehouseId` để dòng sổ cái luôn viết được từ chính kết quả chuyển động.
- Service nhận `actor` chứ không phải `OrgScope`: tồn kho là dữ liệu của nhà cung cấp, không thuộc org nào của buyer, nên không có gì để lọc theo scope; chốt chặn là guard role ops.
- `InventoryDetail` kèm `sku`, `warehouse_code`, `warehouse_name` (join sẵn) để ops console và copilot không phải tra thêm.
- Thêm `GET /inventories` (repo Go có store nhưng chưa expose route).

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| Tái dựng schema sai | Bước 1 đối chiếu tường minh; `inventory_transactions` 15 cột, liệt kê và tick từng cái |
| **Ba primitive sai ⇒ Phase 04 sập** | Chúng được đặc tả, cài đặt **và test hợp đồng null** ở phase này, không để Phase 04 phát hiện |
| Test concurrent flaky | Client riêng mỗi lời gọi (pool ≥20); assert **cả** số lượng thành công **và** bất biến tổng — bất biến tổng một mình bị thoả mãn bởi lần chạy toàn lỗi |
| Quên ghi sổ cái ở một nhánh | Test #1 (nhánh tạo mới) và #4 (nhánh cập nhật) tách riêng |
| `order_id`/`reservation_id` chưa có FK | Cố ý, tránh phụ thuộc vòng. Phase 04 `ALTER TABLE`. Ghi rõ trong migration 005 |
| `version` thành cargo cult | ADR ghi rõ v1 không dùng nó làm lock |
