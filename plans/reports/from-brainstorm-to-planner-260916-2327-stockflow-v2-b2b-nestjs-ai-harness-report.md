# Brainstorm Report — StockFlow v2 (B2B e-commerce, NestJS + AI Harness)

| | |
|---|---|
| Ngày | 2026-09-16 |
| Working dir | `D:\Project field\Personal project\StockFlow v2` (rỗng, chưa git init) |
| Repo nguồn 1 | `D:\Project field\Personal project\StockFlow\StockFlow` (Go/Gin, 6.241 LOC) |
| Repo nguồn 2 | `D:\Project field\Personal project\AI Harness Clone\AI-Harness-Clone` (NestJS + Strands + LiteLLM + pgvector) |
| Trạng thái | **Đã duyệt** — sẵn sàng sang `/ck:plan` |
| Flags | không (`--html`, `--wiki` không dùng) |

---

## 1. Problem statement

Yêu cầu ban đầu (dạng giải pháp): build app e-commerce B2B từ backend StockFlow cũ, với 3 thay đổi — (1) đổi Go/Gin → TypeScript/NestJS giữ nguyên logic, (2) thêm frontend UX/UI thật, (3) áp AI Harness (AWS Bedrock). Mindset business → product → tech, kiến trúc maintain được và luôn có đường mở rộng, tài nguyên có hạn.

### Problem-first inversion (rút gọn)

Yêu cầu là một giải pháp đã chọn sẵn. Vấn đề thật nằm dưới nó:

**Vấn đề nêu:** "port stack + thêm FE + thêm AI".

**Vấn đề thật (phát hiện qua scout):**
1. Repo cũ **không phải app B2B** — không có khái niệm tổ chức mua hàng, giá hợp đồng, phân quyền. Nó là WMS + order backend. "Giữ nguyên logic" ⇒ sẽ ra app B2B không có gì B2B.
2. Repo cũ **không enforce invariant lõi của e-commerce**. Port 1:1 ⇒ port luôn bug, và sửa sau đắt hơn vì FE đã bám vào API shape sai.
3. Mục tiêu thật của người dùng là **học sâu kiến trúc + AI**, không phải ra sản phẩm có user. ⇒ Thước đo tối ưu là "mỗi thứ build ra dạy được gì", không phải "bao nhiêu feature".

**Giả định đã kiểm chứng:** mọi phát hiện ở §2 đọc trực tiếp từ source, không suy đoán.

**Framing cuối:** không phải "port repo", mà **"dùng repo cũ làm xương sống domain để build một hệ thống B2B có 5 bài học kỹ thuật thật, mỗi bài đứng riêng kể được"**.

---

## 2. Scout findings (bằng chứng)

### 2.1 StockFlow (Go/Gin)

**Điểm mạnh — giữ lại:**
- Module-first: `module/<domain>/{model,biz,storage,transport/gin}`, 6 module (user, product, warehouse, inventory, order, payment).
- DI qua **interface hẹp theo từng use case** (`CreateOrderStore`, `AdjustStockStore`) — triết lý tốt, map thẳng sang port của Nest.
- Handwritten SQL, pgx/pgxpool, không ORM. Transaction rõ ràng, có `FOR UPDATE` ở cancel/expire.
- Domain có chiều sâu: order 8 trạng thái; payment có `idempotency_key`; inventory có `version`; `inventory_transactions` ghi before/after cả `available_qty` lẫn `reserved_qty`.

**6 lỗ hổng thật (không phải "chưa làm feature"):**

| # | Lỗ hổng | Bằng chứng |
|---|---|---|
| 1 | **Tạo order không giữ kho** | `storage/sql_order_tx.go::CreateOrder` chỉ INSERT `orders` + `order_items` rồi commit. `inventory_reservations` + DTO `InventoryReserve` + `storage/sql_inventory_reservation.go` có code nhưng **không ai gọi**. Status `reserved` chỉ set nếu client tự truyền `reservation_expires_at`. ⇒ **oversell được** |
| 2 | **Cancel/expire không release reservation** | `CancelOrder`/`ExpireOrder` chỉ đổi `orders.status`, không đụng inventory ⇒ nếu vá #1 mà không vá #2 sẽ rò kho |
| 3 | **Client tự quyết giá** | `model/order_item.go::OrderItemCreate.UnitPrice` lấy thẳng từ body; `line_total = unit_price × quantity`. POST `unit_price: 0` ⇒ mua free |
| 4 | **Tiền là `float64`** | `Order.TotalAmount`, `OrderItem.UnitPrice/LineTotal`, `Payment.Amount`, `Product.Price` |
| 5 | **Không có migration nào** | thư mục `db/` **không tồn tại** trong repo. Schema chỉ tồn tại ngầm trong chuỗi SQL ⇒ không dựng lại DB từ repo được |
| 6 | **Không có auth + 0 test** | `users` có `password_hash` + `role` nhưng không có login/JWT/guard; mọi endpoint public. `find -name "*_test.go"` = 0 |

**Sai lệch tài liệu:** README mô tả "Outbox module" với 4 endpoint — module đó **không tồn tại trong source**.

### 2.2 AI-Harness-Clone

- NestJS 11 + `@strands-agents/sdk` 1.10 + LiteLLM proxy + Postgres/pgvector. `openai` SDK, `zod` 4, `pg` 8.
- Bedrock: Claude Haiku 4.5 (chat), Cohere Embed Multilingual v3 (1024d).
- **Extension seams sẵn có:** model = sửa `config/litellm/config.yaml`; tool = 1 file `tools/builtin/` + 1 dòng `tool.registry.ts`; agent = 1 entry `AGENT_REGISTRY`; memory backend = implement `MemoryStore` + bind DI token `MEMORY_STORE`; strategy = 1 entry `STRATEGY_REGISTRY`.
- **Hạ tầng dùng lại ngay:** zod validation pipe, error envelope `{error:{code,message,details}}`, `x-request-id`, logging interceptor, migration đánh số `db/init/00X_*.sql`, SSE streaming, session + background consolidation.
- Memory: hybrid retrieval (vector ⊕ lexical, hợp nhất RRF), score floor 0.28 đã hiệu chuẩn theo Cohere v3, supersede thay vì xoá.
- Pattern đáng học và sẽ tái dùng: **claim tiến độ trong một statement** (`consolidated_through` marker) — chống double-processing.
- `apps/web` là React+Vite "cố tình thô sơ" để test API ⇒ **không dùng lại làm UI sản phẩm**, chỉ tái dùng SSE client pattern.
- README tự ghi: *"Multi-tenant / RBAC: not built; the `namespace` column and a guard slot are left in place for later"* ⇒ v2 điền đúng vào slot này.

---

## 3. Requirements đã chốt

### 3.1 Quyết định của user

| Câu hỏi | Chọn |
|---|---|
| Mục tiêu v2 | **Học sâu kiến trúc + AI** (không phải portfolio-first, không phải sản phẩm có user) |
| Độ trung thành khi port | **Giữ kiến trúc + từ vựng domain + luồng nghiệp vụ, sửa 6 invariant** |
| AI use case | **Ops copilot** (agent gọi domain service qua tool typed) |
| Độ sâu B2B v1 | **Org + RBAC + contract pricing** |
| Frontend | **Vite + React + TanStack + shadcn/ui (SPA)** — NestJS là backend duy nhất |
| Vị trí AI Harness | **`packages/ai-harness`** — thư viện domain-agnostic trong workspace |
| Tài nguyên | **Full-time 8h/ngày, không deadline** |
| Out of scope v1 | **Deploy AWS + CI/CD**, **Buyer copilot** |

### 3.2 Expected output

Monorepo `stockflow-v2` chạy được bằng `docker compose up`, gồm:
- `apps/api` — NestJS, 8 domain module, REST + SSE, auth JWT, migration đánh số.
- `apps/web` — SPA hai persona: Ops console (~7 màn) + Buyer portal (~5 màn).
- `packages/ai-harness` — agent runtime domain-agnostic, chạy trên Bedrock qua LiteLLM.
- `packages/contracts` — zod schema dùng chung FE/BE.
- `db/migrations/` — schema dựng lại được từ số 0.
- `docs/` — system-architecture, code-standards, ADR.
- Test suite gồm **concurrency test chứng minh không oversell**.

### 3.3 Acceptance criteria

1. **Không oversell:** 50 request song song mua 1 SKU còn 10 đơn vị ⇒ đúng 10 thành công, 40 nhận `INSUFFICIENT_STOCK`, không có `available_qty` âm, tổng ledger khớp. Chạy trên Postgres thật (testcontainers).
2. **Giá do server quyết:** request gửi kèm `unit_price` tuỳ ý ⇒ bị bỏ qua; `order_items.unit_price` luôn khớp kết quả `PriceResolver`; `order_items.price_list_item_id` truy vết được nguồn giá.
3. **Release đúng:** cancel/expire trả lại đúng số lượng đã giữ; gọi 2 lần vẫn đúng (idempotent); reservation quá hạn được scheduler tự release.
4. **Tenant isolation:** user của org A không đọc được order/giá/memory của org B qua bất kỳ endpoint nào, kể cả qua copilot.
5. **Copilot không vượt quyền:** mọi tool đi qua đúng application service có guard; không có SQL thô trong `modules/copilot/`; tool ghi duy nhất chỉ tạo đề xuất chờ duyệt.
6. **Outbox:** state change và event ghi trong cùng transaction; relay xử lý at-least-once; consumer idempotent.
7. **Tiền:** không có kiểu `float`/`number` biểu diễn tiền ở bất kỳ tầng nào.
8. **Dựng lại từ 0:** `docker compose up` trên máy sạch ⇒ DB có schema + seed, API healthy, web mở được.

### 3.4 Non-negotiable constraints

- TypeScript + NestJS 11; handwritten SQL (`pg`), **không ORM** — giữ tinh thần repo cũ.
- Layout module map 1:1 với StockFlow cũ (xem §5.2).
- `packages/ai-harness` **không bao giờ** import `apps/api`.
- `modules/copilot` **không bao giờ** chạm repository/SQL — chỉ gọi application service.
- Không text-to-SQL trong bất kỳ hoàn cảnh nào.
- AI chạy qua LiteLLM → AWS Bedrock.
- Markdown chỉ nằm trong `plans/` và `docs/`.

### 3.5 Touchpoints

Working dir rỗng ⇒ không có file hiện hữu cần sửa. Hai repo nguồn là **read-only reference**:
- Schema phải tái dựng từ `StockFlow/module/*/storage/*.go` (không có migration để copy).
- Logic port từ `StockFlow/module/*/{model,biz,storage}`.
- Harness port từ `AI-Harness-Clone/apps/api/src/{agent,memory,llm,tools,session}` + `db/init/*.sql` + `config/litellm/`.

---

## 4. Approaches đã cân nhắc

### 4.1 Độ trung thành khi port

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| Port 1:1 y nguyên | Nhanh nhất; "giữ nguyên" đúng nghĩa đen | Port luôn 6 lỗ hổng; oversell + mua giá 0đ; sửa sau đắt hơn vì FE đã bám API shape sai | ❌ |
| **Giữ kiến trúc, sửa invariant** | Giữ được module-first + từ vựng + luồng; "logic giữ nguyên" hiểu là ý đồ nghiệp vụ; mỗi lỗ hổng trở thành một bài học | Tốn thêm thời gian ở P3–P4 | ✅ **Chọn** |
| Redesign domain cho B2B | Sạch nhất dài hạn | Tốn nhất; mất tính kế thừa repo cũ mà user muốn giữ | ❌ |

### 4.2 Độ sâu B2B

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| Chỉ org + RBAC | Nhẹ nhất | Bản chất vẫn là B2C có phân quyền — khó biện minh chữ "B2B" | ❌ |
| **Org + RBAC + contract pricing** | Đặc trưng B2B rõ nhất; đồng thời vá luôn lỗ hổng #3; sinh ra pricing engine có port | Chưa có quote/RFQ, chưa có công nợ | ✅ **Chọn** |
| + Quote/RFQ + duyệt đơn | Rất đúng chất B2B | Thêm nhiều state machine + màn hình; scope tăng đáng kể | → v1.1 |
| + Công nợ / Net-30 | Thật nhất về kinh doanh | Kéo theo kế toán, đối soát, aging report | → v1.1 |

### 4.3 AI use case

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Ops copilot** | Chủ yếu read ⇒ rủi ro thấp; giá trị rõ; tận dụng memory dài hạn về ngữ cảnh vận hành | Ít "wow" với người dùng cuối | ✅ **Chọn** |
| Buyer copilot | Ấn tượng hơn với end-user | Agent phải ghi dữ liệu ⇒ cần guardrail nặng; phải xong contract pricing trước | → v1.1 (out of scope v1) |
| Cả hai | Đúng tinh thần "thêm agent = 1 entry" | Gấp đôi công design prompt/tool và bề mặt test | ❌ |
| Chat demo thuần | Rẻ nhất | Gần như vô giá trị; AI thành thứ dán thêm | ❌ |

### 4.4 Frontend stack

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Vite + React SPA** (TanStack Router/Query + shadcn) | NestJS là backend duy nhất ⇒ ranh giới sạch tuyệt đối; không phát sinh câu hỏi BFF; tái dùng SSE client pattern; giữ câu chuyện "agent gọi domain qua một đường duy nhất" không bị làm mờ | Học ít về SSR/RSC | ✅ **Chọn** |
| Next.js 15 App Router | Học RSC/SSR/caching; SEO catalog | Phát sinh tầng kiến trúc thứ hai phải bảo vệ (BFF? token ở đâu?) — nhiễu với mục tiêu học backend | → cân nhắc v2 |
| Next.js SPA-mode | — | Gánh độ phức tạp của Next mà không ăn được lợi ích | ❌ |

### 4.5 Vị trí AI Harness

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **`packages/ai-harness`** | Compiler enforce ranh giới; harness không biết gì về commerce; tách process sau này gần như miễn phí; 1 process hôm nay | Thêm chút công setup workspace | ✅ **Chọn** |
| Nest module trong `apps/api` | Ít file nhất, chạy ngay | Không gì ngăn AI module import thẳng repository commerce ⇒ 6 tháng sau gỡ không ra | ❌ |
| `apps/ai` riêng (2 process) | Thật nhất về vận hành; học service-to-service auth | Gấp đôi hạ tầng + deploy, trả giá ngay khi chưa có lý do | ❌ |

### 4.6 Cơ chế giữ kho (quyết định kỹ thuật, không đưa ra hỏi)

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Conditional atomic UPDATE** (`WHERE available_qty >= $q`) | Atomic sẵn trong 1 statement; ít round-trip; không giữ lock qua nhiều statement; không deadlock nếu sort theo `product_id` | Không tự nhiên cho logic đọc-rồi-quyết phức tạp | ✅ **Chọn** |
| Pessimistic `SELECT … FOR UPDATE` | Quen thuộc; đọc được state trước khi quyết | Giữ lock lâu hơn; cần lock ordering nghiêm ngặt; throughput thấp hơn | Chỉ dùng cho cancel/expire (như repo cũ) |
| Optimistic qua `version` + retry | Throughput cao khi ít tranh chấp | Retry loop phức tạp; tệ khi hot SKU | Giữ `version` cho đường read-modify-write khác |

---

## 5. Giải pháp cuối

### 5.1 Framing: one-seller B2B

Một nhà cung cấp bán cho nhiều **tổ chức mua hàng**, quản lý kho nhiều điểm. **Không** phải marketplace nhiều người bán.

Lý do: mở rộng tự nhiên nhất từ mô hình warehouse-centric của repo cũ, và đủ sinh ra mọi bài học kỹ thuật cần. Marketplace kéo theo seller onboarding / settlement / commission — không dạy thêm gì mới về kiến trúc.

Đường mở: `organizations.type` (`buyer` | `internal`); thành marketplace = thêm `seller` + `seller_org_id` trên product/warehouse.

### 5.2 Năm chương kỹ thuật (xương sống)

| # | Chương | Bài học lõi | Vá lỗ hổng |
|---|---|---|---|
| 1 | Concurrency & transaction | Atomic conditional update, lock ordering, ledger append-only | #1, #2 |
| 2 | Pricing as policy engine | Port + chain of resolvers, audit nguồn giá | #3, #4 |
| 3 | Outbox & eventual consistency | Write cùng tx, relay `SKIP LOCKED`, consumer idempotent | outbox stub bị bỏ dở |
| 4 | Multi-tenant boundary & RBAC | Org scoping, guard, không rò dữ liệu | #6 |
| 5 | Agent over domain tools | Agent không có quyền cao hơn user, human-in-the-loop | — |

Phase xếp theo **chương**, không theo module.

### 5.3 Kiến trúc

```
apps/web (Vite+React+TanStack+shadcn)
  Ops console (chính) · Buyer portal · Copilot (SSE)
        │ REST + SSE — một backend duy nhất
apps/api (NestJS 11, một process)
  modules/  identity · catalog · pricing · warehouse ·
            inventory · ordering · payment · copilot
  platform/ outbox · scheduler · idempotency · db(UoW) ·
            config · errors · observability · ratelimit
        │ inject tools + memory store
packages/ai-harness  (AgentRuntime/Strands · ToolRegistry ·
                      MemoryStore · LlmGateway — domain-agnostic)
        │ OpenAI-compatible
LiteLLM → AWS Bedrock (Claude Haiku 4.5 · Cohere Embed v3)

Postgres: schema `commerce` + schema `ai` (pgvector)   ·   Redis: rate limit
```

**Quy tắc phụ thuộc duy nhất:** `ai-harness` không import `apps/api` (compiler enforce). `copilot` không import repository / không chạm SQL (code review + lint rule enforce).

**Một Postgres, hai schema** — rẻ, một backup, một pool, ranh giới rõ; tách DB sau này = đổi connection string.

### 5.4 Map StockFlow cũ → mới

| Go (cũ) | TS/Nest (mới) |
|---|---|
| `module/x/model/` | `modules/x/domain/` — entity, VO, errors, state machine (thuần, không I/O) |
| `module/x/biz/` | `modules/x/application/` — use case + **ports** |
| `module/x/storage/` | `modules/x/infrastructure/` — SQL viết tay (`pg`) |
| `module/x/transport/gin/` | `modules/x/http/` — controller + DTO (zod) |
| interface hẹp `CreateOrderStore` | port hẹp cùng tên — giữ triết lý "interface theo use case" |
| `component/`, `middleware/` | `platform/` (+ outbox, scheduler, idempotency) |

Module mới so với cũ: `identity`, `pricing`, `copilot`. Còn lại giữ tên.

### 5.5 Domain model (schema `commerce`)

```
organizations(id, code, name, type:'buyer'|'internal', tax_code, status, …)
org_members(org_id, user_id, role:'buyer'|'buyer_admin'|'ops'|'ops_admin')
users(id, email, password_hash, full_name, status, …)

products(id, sku, name, description, base_price numeric(18,2), uom, is_active)
warehouses(id, code, name, address, is_active)

inventory(id, product_id, warehouse_id, available_qty, reserved_qty, version)
          UNIQUE(product_id, warehouse_id)
inventory_transactions(… txn_type, quantity,
          before_available_qty, after_available_qty,
          before_reserved_qty,  after_reserved_qty, reason, created_by)   -- append-only
inventory_reservations(id, order_id, order_item_id, inventory_id,
          quantity, status:'held'|'releasing'|'released'|'consumed', expires_at, …)

price_lists(id, org_id NULL, currency, valid_from, valid_to, priority)     -- org_id NULL = default
price_list_items(price_list_id, product_id, unit_price numeric(18,2), min_qty)  -- bậc SL = nhiều row

orders(id, order_code, buyer_org_id, placed_by_user_id, warehouse_id, status,
       subtotal, total numeric(18,2), currency, reservation_expires_at,
       idempotency_key, paid_at, cancelled_at, fulfilled_at, …)
order_items(id, order_id, product_id, quantity,
       unit_price, line_total numeric(18,2), price_list_item_id)           -- audit nguồn giá
payments(id, order_id, payment_code, method, status, amount,
       idempotency_key, external_txn_id, paid_at, failed_at)

outbox_events(id, aggregate_type, aggregate_id, event_type, payload jsonb,
       occurred_at, processed_at, attempts, last_error)
idempotency_keys(key, org_id, endpoint, request_hash, response_snapshot, status)
```

Order state machine giữ nguyên 8 trạng thái của repo cũ: `pending → reserved → awaiting_payment → paid → fulfilled → completed`, cộng `cancelled`, `expired`.

**Tiền:** `numeric(18,2)` ở DB, integer minor-units trong app. Không float ở bất kỳ đâu.

### 5.6 Trái tim — tạo đơn + giữ kho nguyên tử

Một transaction duy nhất:

```
1. AuthZ        actor ∈ buyer org?  warehouse active?
2. Idempotency  INSERT idempotency_keys(key, org, hash) — trùng → trả response cũ
3. Pricing      PriceResolver.resolve(org, product, qty, now)   ← giá client gửi BỊ BỎ QUA
4. Sort         items ORDER BY product_id                        ← thứ tự khoá ổn định
5. Reserve      mỗi item:
                  UPDATE inventory
                     SET available_qty = available_qty - $q,
                         reserved_qty  = reserved_qty  + $q,
                         version = version + 1
                   WHERE product_id=$p AND warehouse_id=$w
                     AND available_qty >= $q
                  0 row → INSUFFICIENT_STOCK → rollback toàn bộ
6. Write        orders · order_items · inventory_reservations(held, expires_at)
                · inventory_transactions (before/after cả 2 cột)
7. Outbox       INSERT outbox_events('order.created', …)
8. COMMIT
```

**Cancel/expire:** đảo ngược trong một tx, status guard bên trong tx ⇒ gọi 2 lần vẫn đúng.

**Reservation hết hạn:** scheduler claim bằng một statement —
```sql
UPDATE inventory_reservations SET status='releasing'
 WHERE id IN (SELECT id FROM inventory_reservations
              WHERE status='held' AND expires_at < now()
              LIMIT 100 FOR UPDATE SKIP LOCKED)
RETURNING *;
```
Cùng ý tưởng "claim trong một statement" mà AI-Harness dùng cho `consolidated_through` marker.

### 5.7 Pricing engine

```
PriceResolver.resolve(orgId, productId, qty, at) → { unitPrice, sourceId, sourceKind }
```
Thứ tự: price list riêng của org (đang hiệu lực, chọn bậc `min_qty` lớn nhất ≤ qty) → price list mặc định → `product.base_price`. Deterministic.

`order_items.price_list_item_id` lưu nguồn ⇒ sáu tháng sau vẫn trả lời được "vì sao đơn này giá đó".

Đường mở: thêm promotion/campaign = thêm resolver vào chain, không đụng `ordering`.

### 5.8 Auth & RBAC

- JWT access token ngắn + refresh token xoay vòng (lưu hash trong DB). Password hash bằng argon2.
- `@Roles()` decorator + guard; `OrgScopeGuard` bơm `orgId` vào request context.
- Repository nhận `orgId` **tường minh** qua tham số, không dựa vào global state ⇒ dễ test, khó quên.
- Postgres RLS: cân nhắc v2 (vướng connection pooling), ghi vào ADR.

### 5.9 Ops Copilot

`packages/ai-harness` nhận từ `apps/api`: tool list (zod-typed) + memory store + llm gateway config. Không biết "order"/"inventory" là gì.

Tool v1:

| Tool | Gọi vào | Loại |
|---|---|---|
| `get_inventory_status` | `InventoryService.getStatus` | read |
| `find_orders` | `OrderService.list` | read |
| `explain_order_blockers` | `OrderService.diagnose` | read |
| `list_expiring_reservations` | `ReservationService.listExpiring` | read |
| `get_contract_price` | `PriceResolver.resolve` | read |
| `inventory_movement_history` | `LedgerService.history` | read |
| `propose_stock_adjustment` | tạo **đề xuất chờ duyệt**, không ghi kho | write (human-in-the-loop) |

Ba ràng buộc bắt buộc:
1. Mọi tool nhận `actor` (user + org + roles) và đi qua **đúng application service** mà HTTP controller dùng ⇒ agent không bao giờ có quyền cao hơn người đang chat.
2. **Không text-to-SQL.**
3. Tool ghi phải human-in-the-loop trong v1.

Memory namespace `org:<orgId>:<strategy>` ⇒ không rò dữ liệu giữa tổ chức. Chính là slot mà README AI-Harness để trống.

**Chi phí:** Haiku 4.5 + Cohere v3; cache embedding theo hash nội dung; consolidation cadence thưa; LiteLLM virtual key có budget; rate limit riêng cho endpoint copilot (tái dùng Redis limiter từ repo cũ).

### 5.10 Repo layout

```
stockflow-v2/
├── apps/
│   ├── api/src/{modules,platform,main.ts}
│   └── web/src/{routes,features,components,lib}
├── packages/
│   ├── ai-harness/        # agent runtime · memory · llm gateway (domain-agnostic)
│   └── contracts/         # zod schema + type dùng chung FE/BE
├── db/migrations/         # 001_*.sql … đánh số như AI-Harness
├── config/litellm/config.yaml
├── docker-compose.yml     # postgres(pgvector) · redis · litellm · api · web
├── docs/                  # system-architecture · code-standards · adr/
└── plans/
```

`packages/contracts` là thứ AI-Harness chưa có: FE/BE dùng chung zod schema ⇒ đổi API mà quên sửa FE là lỗi **compile**, không phải lỗi runtime.

Tooling: pnpm workspace · Vitest + testcontainers · ESLint + Prettier · migration runner tự viết (~50 dòng, không thêm dependency).

### 5.11 Frontend scope

**Ops console** (ưu tiên, không được cắt): Dashboard · Inventory list + detail (timeline ledger) · Orders list + detail (state machine trực quan + reservations) · Reservations sắp hết hạn · Price lists · Organizations & users · Copilot (SSE streaming, hiện rõ agent đang gọi tool nào).

**Buyer portal**: Catalog (giá hợp đồng của chính mình) · Product detail · Cart · Checkout · My orders + detail.

~12 màn. shadcn/ui + Tailwind, dark/light, empty state + error state tử tế.

---

## 6. Phase plan

| P | Nội dung | Chương |
|---|---|---|
| **P0** | Monorepo, docker-compose, config/env schema, migration runner, error envelope, request-id, logging, health, test harness + testcontainers. **Spike Bedrock/LiteLLM** | móng + gỡ rủi ro sớm |
| **P1** | Identity: organizations, org_members, users, auth (JWT + refresh xoay vòng, argon2), guards, org scoping, seed | 4 |
| **P2** | Catalog + Warehouse + **Pricing engine** + test bậc giá | 2 |
| **P3** | Inventory + ledger + adjust stock atomic | 1 (phần 1) |
| **P4** | **Ordering + reservation nguyên tử**, idempotency, state machine, cancel/expire, **concurrency test suite** | 1 (lõi) |
| **P5** | Outbox relay (`SKIP LOCKED`) + scheduler quét reservation hết hạn + audit projection | 3 |
| **P6** | Payment mô phỏng: checkout/callback + idempotency + chuyển trạng thái đơn | đóng vòng nghiệp vụ |
| **P7** | `packages/ai-harness`: port thành package domain-agnostic, schema `ai`, LiteLLM config | nền AI |
| **P8** | **Ops Copilot**: tool impl qua domain service + actor, agent registry, SSE, memory scope theo org | 5 |
| **P9** | FE foundation + Ops console | UI chính |
| **P10** | FE Buyer portal | đóng vòng người mua |
| **P11** | Docs (system-architecture, ADR), diagram, README, hardening | kể được câu chuyện |

**Ước lượng: 5–7 tuần** ở 8h/ngày. Mỗi phase kết thúc ở trạng thái chạy được và demo được — không bao giờ dở dang.

---

## 7. Chỗ cố ý để trống (đường mở ra, chưa trả giá)

| Để trống | Cách mở sau này |
|---|---|
| Quote/RFQ, duyệt đơn | `ordering` thêm aggregate `quote`; state machine đã tách riêng |
| Công nợ / Net-30 | `organizations.credit_limit` + module `credit`; payment đã có state machine |
| Payment gateway thật | `PaymentGateway` port; simulate là một adapter; thêm SePay/Stripe = thêm adapter |
| Buyer copilot | +1 entry `AGENT_REGISTRY` |
| Event bus ngoài | Outbox relay đổi dispatch in-process → SQS/Kafka; domain không đổi |
| Tách microservice | Ranh giới module + ports đã sẵn |
| AWS + CI/CD | 12-factor, config qua env, API stateless ngay từ P0 |
| Marketplace nhiều seller | `organizations.type` + `seller_org_id` |
| Postgres RLS | ADR ghi sẵn lý do hoãn |
| Next.js / SSR | FE gọi REST thuần ⇒ thay shell không đụng API |

---

## 8. Rủi ro & giảm thiểu

| # | Rủi ro | Giảm thiểu |
|---|---|---|
| 1 | **Strands SDK TS còn non (v1.10)** | `AgentRuntime` nằm sau interface; phương án dự phòng = tool-loop tự viết trên API OpenAI-compatible; `copilot` không đổi một dòng |
| 2 | **Bedrock region / model access** | Spike ngay **P0**, không để đến P7 |
| 3 | **Scope creep ở FE** (12 màn là nhiều) | Nếu chậm: cắt buyer portal xuống 3 màn (catalog · checkout · my orders). **Ops console không được cắt** |
| 4 | **Phải tái dựng schema từ SQL repo cũ** (không có migration) | P0–P3 đọc kỹ `module/*/storage/*.go`, không đoán; viết migration trước, đối chiếu từng cột |
| 5 | **Cám dỗ để copilot chạm thẳng DB** | Ghi thành rule trong `docs/code-standards.md` ngay P0; thêm lint rule chặn import repository từ `modules/copilot` |
| 6 | **Chi phí Bedrock trôi** | LiteLLM virtual key có budget; cache embedding; cadence consolidation thưa; rate limit riêng copilot |
| 7 | **Concurrency test flaky trên Windows** | Testcontainers + Docker Desktop; pin image; seed deterministic |

---

## 9. Success metrics

**Bắt buộc (gate để gọi là v1 xong):**
- 8 acceptance criteria ở §3.3 đều pass.
- `docker compose up` trên máy sạch ⇒ hệ thống chạy end-to-end.
- Concurrency test xanh, chạy lặp 10 lần không flaky.

**Chỉ báo chất lượng kiến trúc:**
- Thêm một resolver giá mới: không sửa file nào trong `modules/ordering`.
- Thêm một tool copilot mới: 1 file + 1 dòng registry, không sửa `ai-harness`.
- Thêm một model LLM: chỉ sửa `config/litellm/config.yaml`.
- Grep `modules/copilot` không ra `SELECT`/`INSERT`/repository import.
- Grep toàn repo không ra kiểu float biểu diễn tiền.

**Chỉ báo mục tiêu học:** mỗi chương ở §5.2 có một mục trong `docs/system-architecture.md` giải thích invariant và lý do chọn, cộng một ADR cho mỗi quyết định có đánh đổi thật.

---

## 10. Next steps

1. `/ck:plan` với report này làm input ⇒ sinh `plans/260916-2327-<slug>/plan.md` + phase files P0–P11.
2. P0 khởi động: `git init`, pnpm workspace, docker-compose, **spike Bedrock trước tiên**.
3. Trước P1: đọc hết `StockFlow/module/*/storage/*.go` để tái dựng schema chính xác.

**Dependencies ngoài tầm kiểm soát:** AWS Bedrock access (Claude Haiku 4.5 + Cohere Embed Multilingual v3) ở region dự định; Docker Desktop cho testcontainers.

---

## 11. Câu hỏi còn treo

1. **Quote/RFQ + payment gateway thật** — user không đánh dấu out-of-scope nhưng câu trả lời B2B depth đã chọn mức không bao gồm chúng. Report xếp vào **v1.1**, schema chừa chỗ. Cần xác nhận lại ở `/ck:plan` nếu muốn kéo vào v1.
2. **Region AWS cụ thể** chưa chốt — quyết ở P0 spike, ảnh hưởng model availability.
3. **Seed data thực tế đến đâu** (bao nhiêu org / SKU / warehouse) — ảnh hưởng độ thuyết phục của demo copilot. Quyết ở P1.
4. **Ngưỡng `reservation_expires_at` mặc định** (15 phút? 24h?) — nghiệp vụ, quyết ở P4.
