---
phase: 4
title: "Ordering, Atomic Reservation & Lifecycle"
status: pending
priority: P1
dependencies: [2, 3]
---

# Phase 04: Ordering, Atomic Reservation & Lifecycle

> **Sửa sau red-team (finding #1, #2, #6, #13, #14, #15, #16).** Bốn thay đổi cấu trúc: bỏ hẳn trạng thái `releasing`; idempotency claim ra **transaction riêng đã commit**; `markPaid` chuyển vào đây (Phase 06 cắt); test #1 assert theo **status code** chứ không chỉ bất biến tổng. 4→5 ngày.

## Overview

**Trái tim của project.** Chương 1 phần lõi. Vá lỗ hổng nghiêm trọng nhất của repo Go: `CreateOrder` chỉ INSERT rồi commit, **không chạm tồn kho** — `inventory_reservations` có code nhưng không ai gọi; `cancel`/`expire` chỉ đổi status.

Phase này biến "không oversell" từ lời hứa thành **bất biến chứng minh được bằng test**.

## Requirements

**Functional**
- `POST /orders` — tạo đơn, **giữ hàng nguyên tử**, giá từ `PriceResolver`, có idempotency key.
- `GET /orders`, `GET /orders/:id` — scope theo `OrgScope` (buyer thấy của mình, ops thấy mọi buyer).
- `POST /orders/:id/cancel`, `POST /orders/:id/expire` — release toàn bộ reservation, idempotent.
- **`POST /orders/:id/mark-paid`** — ops-only, idempotent. *(Thay cho Phase 06 đã cắt.)*
- `POST /orders/:id/fulfill` — reservation → `consumed`, `reserved_qty` giảm.
- Ghi `outbox_events` trong cùng transaction.
- `OrderService.list/get/diagnose`, `ReservationService.listExpiring` — bề mặt Phase 08.

**Non-functional**
- **Không bao giờ oversell**, dưới mọi mức đồng thời.
- Giá client gửi **bị bỏ qua hoàn toàn**; DTO không khai field giá.
- cancel/expire/fulfill/mark-paid gọi nhiều lần cho kết quả như lần đầu.
- Mọi use case nhận `tx: Tx` (D3). READ COMMITTED (đặt ở Phase 00).

## Architecture

### State machine — chỉ giữ trạng thái có người tạo ra

Enum DB giữ đủ 8 giá trị của repo Go (trung thành schema), nhưng **v1 chỉ sinh ra 5**:

```
 create ──► reserved ──► paid ──► fulfilled
               │           │
               ├──► cancelled
               └──► expired
```

| Trạng thái | v1 | Ghi chú |
|---|---|---|
| `reserved`, `paid`, `fulfilled`, `cancelled`, `expired` | **có** | đường sống |
| `pending` | không | repo Go set khi `reservation_expires_at` nil; v2 **luôn** giữ hàng nên không bao giờ nil |
| `awaiting_payment` | không | thuộc payment module đã cắt |
| `completed` | không | v1.1 |

Plan đầu vẽ đủ 8 và bắt UI render đủ 8 — ba trong số đó không có ai tạo ra. Ghi vào `decisions-vs-stockflow.md`.

`order-state-machine.ts` là **hàm thuần**: bảng chuyển trạng thái + `canTransition(from, to)`. Repo Go rải logic này trong `switch` bên trong storage; kéo ra domain để test không cần DB và để scheduler + mark-paid dùng chung một nguồn sự thật.

Quy tắc giữ từ repo Go: `paid`/`fulfilled`/`completed`/`expired` ⇒ không cancel được; `paid`/`cancelled`/`fulfilled`/`completed` ⇒ không expire được.

### Idempotency — claim ra transaction riêng (sửa finding #16)

Plan đầu để claim **bên trong** transaction của đơn. Hai hậu quả: request trùng đồng thời hoặc chặn trên row chưa commit (kẹt request path dưới tải của test #1), hoặc đọc `status='in_progress'` với `response_snapshot` NULL và trả body rỗng; và rollback do `INSUFFICIENT_STOCK` **xoá luôn key**, nên 409 không bao giờ bắn trên đúng đường lỗi phổ biến nhất.

Sửa: **hai transaction**, và ba trạng thái được định nghĩa tường minh.

```
TX-A (ngắn, commit ngay):
  INSERT INTO idempotency_keys (org_id, endpoint, key, request_hash, status)
  VALUES (…, 'in_progress') ON CONFLICT DO NOTHING RETURNING *
  COMMIT
  → 0 row ⇒ đọc row đang có:
       status='in_progress'                  ⇒ 409 IDEMPOTENCY_IN_PROGRESS + Retry-After
       status='completed' & cùng hash        ⇒ 200, phát lại response_snapshot
       hash khác                             ⇒ 409 IDEMPOTENCY_KEY_REUSED

TX-B (transaction của đơn): … 9 bước bên dưới … COMMIT

TX-C (ngắn): UPDATE idempotency_keys SET status='completed', response_snapshot=…
             — hoặc status='failed' nếu TX-B rollback (key được GIẢI PHÓNG để thử lại)
```

**Quyết định: thất bại nghiệp vụ giải phóng key.** `INSUFFICIENT_STOCK` là đường mà client **nên** thử lại sau khi sửa giỏ; đốt key ở đó là sai. Chỉ thành công mới khoá key. Ghi vào ADR 0015.

### Luồng tạo đơn — TX-B

```
1. AuthZ          actor.orgType === 'buyer'; warehouse active
2. Pricing        priceResolver.resolve(scope, actor.orgId, items, now)  ← ≤2 query
                  giá client gửi: bỏ qua. Product thiếu giá ⇒ lỗi, huỷ cả đơn
3. Sort           items.sort(by productId)      ← thứ tự khoá ổn định
4. Reserve        cho từng item (đã sắp xếp):
                     inventoryRepo.reserveAtomic(tx, productId, warehouseId, qty)
                     null ⇒ INSUFFICIENT_STOCK { productId, sku, requested, available }
                            → ném → tx rollback → mọi reserve trước tự hoàn tác
5. Write          orders · order_items (unit_price + price_list_item_id)
                  inventory_reservations (status='held', expires_at)
                  inventory_transactions (txn_type='reserve', before/after từ StockMove)
6. Outbox         outbox_events ('order.created')
7. COMMIT
```

Không `SELECT … FOR UPDATE`: conditional UPDATE đã nguyên tử trong một statement, ít lock time hơn. Sort theo `productId` để hai đơn mua chéo SKU không deadlock.

Rollback đủ để hoàn tác các reserve trước đó **vì tất cả nằm trong một transaction** — đây chính là lý do không tách reserve thành service gọi qua HTTP (sẽ mất nguyên tử và phải viết saga). ADR 0013.

### Thứ tự khoá thống nhất — sửa finding về 4 lock order

Bốn đường ghi chạm cùng bộ row. Quy tắc **một** thứ tự cho cả hệ thống, ghi vào `code-standards.md`:

> `orders` (theo `id`) → `inventory_reservations` (theo `id`) → `inventory` (theo `product_id`)

| Luồng | Tuân thủ |
|---|---|
| create-order | không chạm `orders` cũ; `inventory` theo `product_id` ✓ |
| cancel / expire / fulfill / mark-paid | `FOR UPDATE` trên `orders` trước, rồi reservation `ORDER BY id`, rồi `inventory` |
| sweeper (Phase 05) | claim `orders` `FOR UPDATE SKIP LOCKED` trước — cùng thứ tự |
| adjust-stock (Phase 03) | chỉ chạm `inventory`, upsert một statement — không giữ lock qua statement |

### Luồng huỷ / hết hạn / fulfill — và vì sao **không** có `releasing` (sửa finding #1, D2)

Plan đầu cho sweeper set `status='releasing'` rồi gọi use case vốn chỉ lặp `status='held'` ⇒ **0 row khớp**, đơn thành `expired`, kho không trả, reservation kẹt vĩnh viễn. Cộng thêm `LIMIT $batch` chia nhỏ đơn nhiều dòng và guard idempotent khoá phần còn lại.

Sửa tận gốc: **xoá trạng thái `releasing`.** Sweeper claim **đơn hàng**, không claim reservation, và claim bằng chính row lock trong transaction làm việc:

```
TX (một đơn, một transaction):
  SELECT … FROM orders WHERE id=$1 FOR UPDATE            -- lock LÀ claim
  scope check (OrgScope)
  status đã terminal (cancelled/expired)? ⇒ trả nguyên trạng, KHÔNG lỗi  (idempotent)
  canTransition(current, target)? ⇒ không thì ORDER_CANNOT_BE_*
  SELECT … FROM inventory_reservations
   WHERE order_id=$1 AND status='held' ORDER BY id FOR UPDATE   -- TOÀN BỘ đơn, không LIMIT
  cho từng reservation:
      releaseAtomic(tx, inventoryId, qty)     (hoặc consumeAtomic cho fulfill)
      ledger.append(tx, txn_type='release'|'consume', …)
      reservation.status = 'released'|'consumed', released_at/consumed_at = now()
  orders.status = target; mốc thời gian tương ứng
  outbox('order.cancelled'|'order.expired'|'order.fulfilled'|'order.paid')
COMMIT
```

Một đơn = một transaction = tất-cả-hoặc-không. Không có trạng thái trung gian nên không có ngõ cụt; không có `LIMIT` trong phạm vi một đơn nên không có under-release.

`inventory_reservations.status` chỉ còn **`held | released | consumed`**.

### Schema (migration `006_ordering.sql`)

```sql
orders(
  id uuid pk, order_code text unique not null,
  buyer_org_id uuid not null references organizations(id),
  placed_by_user_id uuid not null references users(id),
  warehouse_id uuid not null references warehouses(id),
  status text not null check (status in
    ('pending','reserved','awaiting_payment','paid','fulfilled','completed','cancelled','expired')),
  subtotal numeric(18,2) not null,
  total    numeric(18,2) not null,
  currency char(3) not null check (currency = 'VND'),
  reservation_expires_at timestamptz,
  paid_at, cancelled_at, fulfilled_at timestamptz,
  created_at, updated_at)
create index on orders (buyer_org_id, created_at desc);
create index on orders (status, reservation_expires_at) where status = 'reserved';

order_items(
  id uuid pk, order_id uuid references orders(id) on delete cascade,
  product_id uuid not null references products(id),
  quantity int not null check (quantity > 0),
  unit_price numeric(18,2) not null check (unit_price >= 0),
  line_total numeric(18,2) not null,
  price_list_item_id uuid null references price_list_items(id),   -- audit nguồn giá
  created_at)

inventory_reservations(
  id uuid pk,
  order_id uuid not null references orders(id),
  order_item_id uuid not null references order_items(id),
  inventory_id uuid not null references inventory(id),
  product_id uuid not null, warehouse_id uuid not null,
  quantity int not null check (quantity > 0),
  status text not null check (status in ('held','released','consumed')),  -- KHÔNG có 'releasing'
  expires_at timestamptz,
  reserved_at timestamptz not null default now(),
  released_at, consumed_at timestamptz,
  created_at, updated_at)
create index on inventory_reservations (order_id, status);
create index on inventory_reservations (status, expires_at) where status = 'held';

-- MỘT nguồn sự thật cho "đã xử lý" (sửa finding #14)
outbox_events(
  id bigserial pk, aggregate_type text not null, aggregate_id uuid not null,
  event_type text not null, payload jsonb not null,
  org_id uuid not null,                       -- NOT NULL: sự kiện phải quy được về org
  occurred_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','processed','dead')),
  attempts int not null default 0,            -- đếm THẤT BẠI, không đếm claim
  next_attempt_at timestamptz, last_error text,
  processed_at timestamptz)
create index on outbox_events (status, next_attempt_at, id) where status = 'pending';

idempotency_keys(
  org_id uuid not null, endpoint text not null, key text not null,
  request_hash text not null, response_snapshot jsonb,
  status text not null default 'in_progress'
    check (status in ('in_progress','completed','failed')),
  created_at timestamptz not null default now(),
  primary key (org_id, endpoint, key))

alter table inventory_transactions
  add constraint fk_itx_order       foreign key (order_id)       references orders(id),
  add constraint fk_itx_reservation foreign key (reservation_id) references inventory_reservations(id);
```

`outbox_events` có **một** cột trạng thái (`status`), không còn cặp `processed_at`+`status` mâu thuẫn. `processed_at` chỉ là dấu thời gian, không phải predicate. `org_id NOT NULL` để Phase 05 projection không sinh row không quy được về tenant.

**`order_code`:** repo Go dùng `RANDOM()` 6 chữ số + `UNIQUE` — va chạm là chuyện sớm muộn và sẽ ném lỗi giữa transaction. Thay bằng sequence theo ngày `ORD-YYYYMMDD-<nextval padded>`. Lưu ý: mã tuần tự **đoán được**, nên mọi endpoint nhận `order_code`/`order_id` phải scope-check (đã có qua `OrgScope`).

## Related Code Files

**Create**
- `db/migrations/006_ordering.sql`
- `apps/api/src/modules/ordering/**`
- `packages/contracts/src/ordering.ts`
- `docs/adr/0013-atomic-reservation-over-pessimistic-lock.md`
- `docs/adr/0014-order-code-generation.md`
- `docs/adr/0015-idempotency-strategy.md`
- `docs/adr/0016-order-lifecycle-without-payment-module.md`

**Modify**
- `apps/api/src/app.module.ts`
- `docs/code-standards.md` — **thứ tự khoá thống nhất** + "mọi đổi trạng thái đơn ghi outbox cùng tx"

**Reference (read-only)**
- `StockFlow/module/order/storage/sql_order_tx.go` — **đọc kỹ** `CreateOrder`, `CancelOrder`, `ExpireOrder`, `generateOrderCode`
- `StockFlow/module/order/model/{order.go,order_item.go,errors.go}`
- `StockFlow/module/order/biz/*.go`
- `StockFlow/module/inventory/model/inventory_reservation.go` — DTO chưa từng được dùng
- `StockFlow/module/payment/model/payment.go` — chỉ để tham khảo `IdempotencyKey`; module payment đã cắt

## Tests First (TDD — nghiêm; phase quan trọng nhất)

**Nhóm A — bất biến tồn kho**

1. `ordering/no-oversell-concurrent.spec.ts` — **AC#1.** Tồn 10, 50 request song song mỗi đơn 1 đơn vị ⇒ **đúng 10 response 2xx và đúng 40 response 409 `INSUFFICIENT_STOCK`** (assert theo **status code**, không chỉ bất biến tổng — một lần chạy toàn 500 phải **FAIL**). `available_qty=0`, `reserved_qty=10`, 10 row sổ cái `reserve`. **Lặp 10 lần.**
2. `ordering/partial-failure-rollback.spec.ts` — đơn 3 item, item 3 thiếu ⇒ rollback toàn bộ; tồn item 1,2 **không đổi**; không row `orders`/`order_items`/`reservations`/ledger/outbox nào.
3. `ordering/no-deadlock-crossing.spec.ts` — 2×20 song song, nhóm A mua [SKU1,SKU2], nhóm B mua [SKU2,SKU1] ⇒ không transaction nào fail vì deadlock (assert không có `40P01` trong log).
4. **`ordering/no-deadlock-mixed-flows.spec.ts`** — create-order, cancel, adjust-stock, và sweeper chạy **đồng thời** trên cùng bộ SKU ⇒ không deadlock. *(Plan đầu chỉ test create-vs-create.)*
5. `ordering/invariant-sum.spec.ts` — chuỗi ngẫu nhiên create/cancel/expire/fulfill/mark-paid: mọi SKU có `available + reserved` = tổng đã adjust, và tổng delta sổ cái khớp trạng thái hiện tại.

**Nhóm B — giá**

6. `ordering/price-from-server.spec.ts` — **AC#2.** Client POST kèm `unit_price: 0` và `999999` ⇒ bỏ qua; `order_items.unit_price` khớp `PriceResolver`; `line_total`, `total` đúng.
7. `ordering/price-audit-trail.spec.ts` — `price_list_item_id` trỏ đúng row; product rơi về `base_price` ⇒ cột NULL và vẫn tạo được đơn.
8. `ordering/price-per-org.spec.ts` — cùng SKU, cùng qty, org A và B ⇒ hai mức giá khác nhau theo bảng hợp đồng.

**Nhóm C — vòng đời**

9. `ordering/cancel-releases-stock.spec.ts` — **AC#3.** Tạo đơn 5 ⇒ available −5, reserved +5. Cancel ⇒ về đúng ban đầu, reservation `released`, có ledger `release`.
10. **`ordering/cancel-releases-all-lines.spec.ts`** — đơn **3 dòng** ⇒ cancel release **cả ba**, `available` phục hồi đủ. *(Bắt lỗi under-release mà plan đầu có.)*
11. `ordering/cancel-twice-idempotent.spec.ts` — cancel 2 lần ⇒ lần hai trả cùng kết quả, **không** release thêm. Tương tự expire.
12. `ordering/state-machine.spec.ts` — thuần, không DB: mọi cặp (from,to) hợp lệ/không. Đơn `paid` ⇒ cancel từ chối; `cancelled` ⇒ fulfill từ chối. **Chỉ phủ 5 trạng thái v1 sinh ra**; 3 trạng thái còn lại assert là không có đường vào.
13. **`ordering/mark-paid.spec.ts`** — ops mark-paid đơn `reserved` ⇒ `paid`, `paid_at` set, outbox `order.paid`. Buyer gọi ⇒ 403. Gọi 2 lần ⇒ idempotent.
14. `ordering/fulfill-consumes.spec.ts` — fulfill ⇒ reservation `consumed`, `reserved_qty` giảm, `available_qty` **không** đổi, ledger `consume`. Gọi 2 lần ⇒ idempotent.

**Nhóm D — idempotency, outbox, scope**

15. `ordering/idempotency-key.spec.ts` — cùng key + cùng body 2 lần ⇒ một đơn, lần hai trả **đúng response cũ** (assert cả status lẫn body, không chỉ "một đơn"). Cùng key + khác body ⇒ 409 `IDEMPOTENCY_KEY_REUSED`.
16. `ordering/idempotency-concurrent.spec.ts` — hai request cùng key **song song** ⇒ đúng một đơn; request thua nhận **409 `IDEMPOTENCY_IN_PROGRESS`**, không phải body rỗng.
17. **`ordering/idempotency-released-on-business-failure.spec.ts`** — `INSUFFICIENT_STOCK` ⇒ key ở `failed`; thử lại **cùng key** sau khi sửa giỏ ⇒ **thành công**, không bị 409.
18. `ordering/outbox-same-tx.spec.ts` — tạo đơn thành công ⇒ đúng một row outbox `status='pending'` với `org_id` đúng. Tạo đơn thất bại ⇒ **không** row outbox nào.
19. `ordering/scope.spec.ts` — buyer org A không list/get/cancel được đơn org B (get chéo ⇒ 404). **Ops list được đơn của cả A và B** qua `OrgScope`.

## Implementation Steps

1. **Đọc `sql_order_tx.go` từ đầu đến cuối.** Ghi danh sách: port nguyên vs cố ý sửa (reservation, order_code, float→Money, org scope, bỏ `releasing`, bỏ 3 trạng thái). Danh sách vào commit message và `decisions-vs-stockflow.md`.
2. Migration `006_ordering.sql` + `ALTER TABLE` bổ sung FK cho Phase 03.
3. `order-state-machine.ts` (thuần) + test #12 — xanh ngay, không cần DB.
4. Viết 18 test còn lại — đỏ. **Không implementation trước bước này.**
5. `domain/`: `Order`, `OrderItem`, `OrderStatus`, `errors.ts`. Port validate từ `model/order.go`.
6. `ports/`: `OrderRepository`, `ReservationRepository`, `OutboxRepository`, `IdempotencyRepository` — interface hẹp theo use case, mọi method nhận `tx: Tx`, method đọc nhận `scope: OrgScope`.
7. `IdempotencyService` — TX-A/TX-C ở §Architecture. Nó **tự** mở transaction riêng (ngoại lệ có chủ đích với rule D3, ghi vào ADR 0015 vì đó chính là điểm mấu chốt). Test #15–#17 xanh.
8. `CreateOrderUseCase(tx, actor, input)` — 7 bước TX-B. Nhóm A, B, D xanh.
9. `CancelOrderUseCase`, `ExpireOrderUseCase` — khối release **toàn bộ** reservation `held` của đơn, không `LIMIT`. Guard idempotent trước `canTransition`. Test #9–#11 xanh.
10. `MarkPaidUseCase` (ops-only) + `FulfillOrderUseCase`. Test #13, #14 xanh.
11. `GetOrder`/`ListOrders` nhận `scope`. Test #19 xanh.
12. `OrderService` (`list`, `get`, `diagnose(scope, orderId)`) + `ReservationService` (`listExpiring(scope, withinMinutes)`) — **tạo ở đây**, Phase 08 chỉ tiêu thụ. Mọi method nhận `scope: OrgScope` đầu tiên.
13. `http/`: controller mở `withTransaction` và truyền `tx`. **DTO không khai `unit_price`.**
14. Chạy test #1 mười lần liên tiếp. ADR 0013–0016.

## Success Criteria

- [ ] Toàn bộ 19 test xanh.
- [ ] Test #1 chạy 10 lần liên tiếp đều xanh, **và assert theo status code** (một lần chạy toàn 500 phải làm test đỏ).
- [ ] Test #4 (create + cancel + adjust + sweeper đồng thời) không deadlock.
- [ ] Đơn 3 dòng cancel ⇒ release **đủ cả ba**.
- [ ] Đơn thất bại giữa chừng không để lại **bất kỳ** row nào.
- [ ] `INSUFFICIENT_STOCK` ⇒ thử lại cùng idempotency key vẫn thành công.
- [ ] Hai request cùng key song song ⇒ một đơn, cái thua nhận 409 có nghĩa.
- [ ] `order_items.unit_price` không bao giờ từ request body (DTO không khai field đó).
- [ ] Ops list được đơn mọi buyer org; buyer chỉ thấy của mình.
- [ ] **Không xuất hiện chuỗi `releasing` ở bất kỳ đâu trong `modules/ordering`** (grep).
- [ ] `order_code` không va chạm khi tạo 10.000 đơn cùng ngày.
- [ ] ADR 0013–0016 tồn tại.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| **Test concurrent flaky** ⇒ mất niềm tin vào bất biến đắt nhất | Pool ≥60 (container `max_connections=200`); `fileParallelism:false` (Phase 00); assert **status code** nên lần chạy toàn lỗi không thể pass; chạy 10 lần là bước bắt buộc |
| Deadlock dưới tải hỗn hợp | **Thứ tự khoá thống nhất** ghi trong code-standards, áp cho cả 4 luồng; test #4 phủ hỗn hợp chứ không chỉ create-vs-create |
| Under-release đơn nhiều dòng | Sweeper claim **đơn**, không claim reservation; không `LIMIT` trong phạm vi một đơn; test #10 |
| Idempotency race / key bị đốt oan | Claim ở transaction riêng đã commit; ba trạng thái tường minh; test #16, #17 |
| Quên scope ở một query | `scope` là tham số bắt buộc trong port; test #19 kiểm cả hai chiều (buyer bị chặn, ops đi qua) |
| `response_snapshot` phình to | Chỉ lưu response đã serialize; job dọn theo TTL ở Phase 05; ghi vào ADR 0015 |
| Port sót một nhánh logic Go | Bước 1 tạo danh sách đối chiếu tường minh; mọi khác biệt phải **cố ý** và ghi ra |
| `CreateOrder` phình to | Tách bước 2 (pricing) và 4 (reserve) thành private method có tên rõ; hàm chính đọc như 7 bước |
