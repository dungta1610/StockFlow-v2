---
phase: 5
title: "Outbox Relay, Scheduler & Audit"
status: completed
priority: P1
dependencies: [4]
---

# Phase 05: Outbox Relay, Scheduler & Audit

> **Sửa sau red-team (finding #1, #5, #12, #14).** Bốn thay đổi: job và dispatcher binding chuyển từ `platform/` vào `modules/` (lint rule của Phase 00 khiến bản cũ **không compile được**); sweeper không mở transaction lồng nhau nữa; `attempts` đếm **thất bại** chứ không đếm claim; `audit_log` có chủ, có scope, có redaction. 2→3 ngày.

## Overview

Chương 3 — **Outbox & eventual consistency**. Repo Go để outbox làm stub rồi bỏ (README mô tả 4 endpoint, source không có module). Đây là seam đòn bẩy lớn nhất: có outbox thì async, event-driven, notification, analytics sau này đều gắn vào mà không sửa domain.

Cộng: scheduler tự release reservation quá hạn — biến `POST /orders/:id/expire` thủ công thành cơ chế tự vận hành.

## Requirements

**Functional**
- Relay poll event `pending`, dispatch tới handler in-process, đánh dấu `processed`.
- Retry có backoff; quá `maxAttempts` ⇒ `dead`, không chặn hàng đợi.
- Sweeper quét đơn `reserved` quá hạn ⇒ expire + release (dùng đúng `ExpireOrderUseCase` của Phase 04).
- Job dọn `idempotency_keys` quá TTL.
- Consumer v1: **audit projection**.
- `GET /ops/outbox?status=dead` và `GET /ops/audit` — `ops_admin`, có scope.

**Non-functional**
- **At-least-once**, không exactly-once. Mọi consumer phải idempotent.
- Nhiều instance chạy song song không xử lý trùng ⇒ `FOR UPDATE SKIP LOCKED`.
- **Không transaction lồng nhau** (D3).
- Relay không chặn request path; lỗi một event không hỏng event khác.

## Architecture

### Phân chia `platform/` ↔ `modules/` — sửa finding #12

Plan đầu đặt `reservation-expiry.job.ts` và outbox dispatcher (routing `order.*`) vào `platform/`, trong khi Phase 00 **cấm** `platform/` import `modules/` và đặt đó thành success criterion. Không compile được.

| `platform/outbox/` — **cơ chế**, không biết domain | `modules/` — **chính sách**, biết domain |
|---|---|
| `outbox.relay.ts` — poll, claim, dispatch, retry, dead | `modules/ordering/application/outbox-bindings.ts` — `order.*` → handler nào |
| `outbox-handler.interface.ts` | `modules/audit/application/audit-log.handler.ts` |
| `platform/scheduler/scheduler.runner.ts` — chạy job theo chu kỳ, guard chồng lượt | `modules/ordering/application/reservation-expiry.job.ts` |
| | `modules/ordering/application/idempotency-cleanup.job.ts` |

`platform/` cung cấp *runner* và *registry token*; `modules/` đăng ký vào. Chiều phụ thuộc luôn là `modules/ → platform/`.

```
platform/outbox/{outbox.relay.ts, outbox-handler.interface.ts, outbox.module.ts}
platform/scheduler/{scheduler.runner.ts, scheduler.module.ts, job.interface.ts}
modules/ordering/application/{outbox-bindings.ts, reservation-expiry.job.ts, idempotency-cleanup.job.ts}
modules/audit/{application/audit-log.handler.ts, infrastructure/sql-audit.repository.ts, http/audit.controller.ts}
```

`modules/audit` gọn còn **3 file** — nó là một projection, không phải một domain (finding YAGNI).

### Relay loop — `attempts` đếm thất bại (sửa finding #14)

Plan đầu tăng `attempts` **lúc claim**. Một vòng restart (crash sau claim, trước dispatch) sẽ dead-letter những event **chưa từng được giao lần nào** — vi phạm AC#6.

```sql
-- claim: KHÔNG tăng attempts, chỉ giữ lock trong transaction đang mở
SELECT * FROM outbox_events
 WHERE status = 'pending'
   AND (next_attempt_at IS NULL OR next_attempt_at <= now())
 ORDER BY id LIMIT $batch
 FOR UPDATE SKIP LOCKED;
```

Dispatch từng event **trong cùng transaction đã giữ lock**:
- thành công ⇒ `status='processed'`, `processed_at=now()`
- thất bại ⇒ `attempts = attempts + 1`, `last_error`, `next_attempt_at = now() + backoff(attempts)`; vượt `maxAttempts` ⇒ `status='dead'`

**Crash sau claim, trước dispatch:** transaction chưa commit ⇒ lock nhả ⇒ event quay lại `pending` nguyên vẹn, `attempts` không tăng. Đây là hành vi đúng cho at-least-once, và nó **miễn phí** khi claim là row lock thay vì cập nhật trạng thái.

`ORDER BY id` + `SKIP LOCKED` giữ thứ tự tương đối trong khi cho nhiều worker chạy. **Không** đảm bảo thứ tự tuyệt đối toàn cục — consumer không được giả định có. ADR 0017.

```ts
export interface OutboxHandler {
  readonly eventTypes: string[]
  handle(tx: Tx, event: OutboxEvent): Promise<void>   // PHẢI idempotent
}
```
Handler nhận `tx` — chạy trong cùng transaction với việc đánh dấu processed, nên "đã xử lý" và "đã ghi" không bao giờ lệch nhau.

**Đường mở ra (ADR 0017):** đổi `dispatch()` từ in-process sang SQS/SNS/Kafka không đụng domain và không đụng relay — chỉ thay implementation của dispatcher.

### Reservation expiry job — không lồng transaction (sửa finding #1, #5)

Plan đầu: sweeper mở transaction, claim reservation thành `releasing`, rồi gọi `ExpireOrderUseCase` — vốn tự mở transaction riêng. Hai connection, chờ lock chéo, **treo vĩnh viễn** mà Postgres không phát hiện (một cạnh ở tầng app). Và `releasing` là ngõ cụt.

Sửa: sweeper lấy **danh sách id** ngoài transaction, rồi mỗi đơn một transaction, gọi use case với `tx` của chính nó.

```
mỗi RESERVATION_SWEEP_INTERVAL:
  ids = SELECT id FROM orders
         WHERE status = 'reserved' AND reservation_expires_at < now()
         ORDER BY id LIMIT $batch            -- chỉ đọc, KHÔNG transaction dài
  for each id:
      unitOfWork.withTransaction(tx =>
        expireOrderUseCase.execute(tx, systemActor, { orderId: id }))
      // use case tự SELECT … FOR UPDATE trên orders — lock LÀ claim
      // hai sweeper cùng lấy một id: cái thứ hai thấy status đã 'expired' ⇒ idempotent, no-op
```

Không cần `SKIP LOCKED` ở đây vì `ExpireOrderUseCase` đã idempotent (Phase 04). Hai sweeper chạy song song thì cái thứ hai chỉ tốn một no-op. Đơn giản hơn, và không có trạng thái trung gian nào để kẹt.

Đơn `paid` không bao giờ bị expire: lọc `status='reserved'` ở query **và** `canTransition` trong use case (defense in depth).

`systemActor` là actor nội bộ có `OrgScope = all-buyers` — định nghĩa một chỗ trong `modules/identity`, không phải bypass rải rác.

### `audit_log` — có chủ, có scope, có redaction (sửa finding #14)

Plan đầu: `payload jsonb` nguyên văn của mọi event mọi org, `org_id` **nullable**, không role, không test đường đọc, mà Phase 09 lại đọc nó cho timeline. `order.created` mang `unit_price` + `price_list_item_id` — dữ liệu nhạy cảm nhất trong B2B.

```sql
audit_log(
  id bigserial pk,
  event_id bigint not null unique,        -- khoá idempotent của consumer
  aggregate_type text not null, aggregate_id uuid not null,
  event_type text not null,
  org_id uuid not null references organizations(id),   -- NOT NULL
  actor_user_id uuid references users(id),
  summary jsonb not null,                 -- projection ĐÃ LỌC, không phải payload thô
  occurred_at timestamptz not null, recorded_at timestamptz not null default now())
create index on audit_log (aggregate_type, aggregate_id, occurred_at desc);
create index on audit_log (org_id, occurred_at desc);
```

- `event_id UNIQUE` + `ON CONFLICT DO NOTHING` = cách consumer tự làm mình idempotent. Mẫu cho consumer sau bắt chước.
- `org_id NOT NULL` ⇒ từ chối projection sự kiện không quy được về tenant (`outbox_events.org_id` cũng NOT NULL từ Phase 04).
- **`summary` là projection đã lọc**, không phải payload thô: giữ trạng thái, mốc thời gian, số lượng; **bỏ đơn giá và nguồn giá**. Danh sách field cho mỗi `event_type` khai tường minh trong `audit-log.handler.ts`.
- `GET /ops/audit` yêu cầu `ops_admin` **và** nhận `OrgScope`.

### Migration `007_outbox_audit.sql`

Chỉ tạo `audit_log`. `outbox_events` đã có hình dạng cuối ở migration 006 (một cột `status`) — plan đầu chia hai migration rồi tạo ra hai nguồn sự thật.

## Related Code Files

**Create**
- `db/migrations/007_outbox_audit.sql`
- `apps/api/src/platform/outbox/{outbox.relay.ts,outbox-handler.interface.ts,outbox.module.ts}`
- `apps/api/src/platform/scheduler/{scheduler.runner.ts,job.interface.ts,scheduler.module.ts}`
- `apps/api/src/modules/ordering/application/{outbox-bindings.ts,reservation-expiry.job.ts,idempotency-cleanup.job.ts}`
- `apps/api/src/modules/ordering/http/ops-outbox.controller.ts`
- `apps/api/src/modules/audit/{application/audit-log.handler.ts,infrastructure/sql-audit.repository.ts,http/audit.controller.ts}`
- `docs/adr/0017-transactional-outbox.md`
- `docs/adr/0018-reservation-expiry-via-order-lock.md`
- `docs/adr/0019-audit-log-scoping-and-redaction.md`

**Modify**
- `apps/api/src/app.module.ts`
- `apps/api/src/modules/identity/domain/actor.ts` — thêm `systemActor`
- `.env.example` — `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS`, `RESERVATION_SWEEP_INTERVAL_MS`, `RESERVATION_SWEEP_BATCH`, `IDEMPOTENCY_TTL_HOURS`
- `docs/code-standards.md` — "mọi `OutboxHandler` phải idempotent, ghi rõ cách đạt được"

**Reference (read-only)**
- `AI-Harness-Clone/apps/api/src/session/session.service.ts` — pattern claim marker trong một statement
- `AI-Harness-Clone/docs/system-architecture.md` §"Invariant 2 — gate bằng marker tiến"

## Tests First (TDD — nghiêm)

1. `outbox/relay-dispatches.spec.ts` — 3 event ⇒ cả 3 `status='processed'`, handler gọi đúng 3 lần đúng payload.
2. `outbox/relay-concurrent-claim.spec.ts` — **2 relay song song** trên 100 event ⇒ mỗi event dispatch **đúng một lần**, không trùng không sót.
3. **`outbox/crash-after-claim.spec.ts`** — mô phỏng crash giữa claim và dispatch (rollback transaction) ⇒ event trở lại `pending`, **`attempts` KHÔNG tăng**, lượt sau xử lý bình thường.
4. `outbox/retry-backoff.spec.ts` — handler ném lỗi ⇒ `attempts` tăng, `next_attempt_at` lùi tương lai, không đánh dấu processed. Sau `maxAttempts` ⇒ `dead`.
5. `outbox/dead-event-does-not-block.spec.ts` — event luôn lỗi nằm giữa hàng đợi ⇒ các event sau vẫn xử lý.
6. `outbox/handler-idempotent.spec.ts` — dispatch cùng event 2 lần ⇒ `audit_log` 1 row.
7. **`outbox/single-source-of-truth.spec.ts`** — sau khi xử lý, **không** event nào có `status='processed'` mà `processed_at IS NULL`, và không cái nào còn ở index `pending`. Claim query và index dùng **cùng** predicate.
8. `scheduler/expiry-releases-stock.spec.ts` — **AC#3.** Đơn quá hạn ⇒ sweep ⇒ đơn `expired`, reservation `released`, tồn kho về đúng mức trước, ledger có `release`.
9. **`scheduler/expiry-releases-all-lines.spec.ts`** — đơn **3 dòng**, `RESERVATION_SWEEP_BATCH=2` ⇒ vẫn release **đủ ba dòng** (batch giới hạn số **đơn**, không cắt giữa một đơn).
10. `scheduler/expiry-skips-paid.spec.ts` — đơn `paid` dù quá hạn ⇒ không expire, tồn kho không đổi.
11. `scheduler/expiry-concurrent.spec.ts` — 2 sweeper song song trên 50 đơn quá hạn ⇒ mỗi đơn release **đúng một lần**, tồn kho không cộng đúp.
12. **`scheduler/no-nested-transaction.spec.ts`** — job chạy trong khi một transaction khác giữ lock trên cùng đơn ⇒ job **timeout theo `lock_timeout` (5s)** và ghi log, **không treo vĩnh viễn**.
13. `scheduler/idempotency-cleanup.spec.ts` — key quá TTL bị xoá, key còn hạn giữ nguyên.
14. **`audit/redaction.spec.ts`** — `audit_log.summary` của `order.created` **không chứa** `unit_price` hay `price_list_item_id`.
15. **`audit/scope.spec.ts`** — `ops_admin` đọc được; `ops` thường ⇒ 403; buyer ⇒ 403; và với `OrgScope`, buyer org B **không** đọc được row của org A kể cả khi đoán đúng `aggregate_id`.
16. **`platform/no-domain-import.spec.ts`** — quét `apps/api/src/platform/`: không import nào trỏ `modules/`. *(Gate cho finding #12.)*

## Implementation Steps

1. Migration `007_outbox_audit.sql` (chỉ `audit_log`).
2. Viết 16 test ở §Tests First — đỏ.
3. `platform/outbox/`: `OutboxHandler` interface, `OutboxRelay` (claim bằng row lock, dispatch trong cùng tx, backoff hàm mũ có jitter). Guard chống chồng lượt. Test #1–#5, #7 xanh.
4. `platform/scheduler/`: runner chạy job theo chu kỳ + guard chồng lượt + `job.interface.ts`.
5. `modules/ordering/application/outbox-bindings.ts` — map `order.*` → handler. Đăng ký vào registry token của `platform/outbox`.
6. `modules/audit/` (3 file): `AuditLogHandler` với `ON CONFLICT (event_id) DO NOTHING`, projection `summary` **khai tường minh field cho từng event type**. Test #6, #14 xanh.
7. `modules/ordering/application/reservation-expiry.job.ts` — đọc id ngoài tx, mỗi đơn một `withTransaction` gọi `ExpireOrderUseCase`. `systemActor`. Test #8–#12 xanh.
8. `idempotency-cleanup.job.ts` theo `IDEMPOTENCY_TTL_HOURS`.
9. `ops-outbox.controller.ts` (`GET /ops/outbox?status=dead`, `ops_admin`) và `audit.controller.ts` (`GET /ops/audit`, `ops_admin` + scope). Test #15 xanh.
10. Test #16 xanh — nếu đỏ nghĩa là ranh giới `platform/` lại bị phá.
11. ADR 0017, 0018, 0019.

## Success Criteria

- [x] 16 test ở §Tests First xanh.
- [x] **`platform/` không import `modules/`** — test #16 và ESLint cùng xác nhận.
- [x] Crash giữa claim và dispatch ⇒ event không mất, `attempts` không tăng oan.
- [x] Hai relay song song trên 100 event ⇒ mỗi event đúng một lần.
- [x] Hai sweeper song song trên 50 đơn ⇒ không cộng đúp.
- [x] Đơn 3 dòng với batch 2 ⇒ release đủ cả ba.
- [x] Job gặp lock ⇒ timeout 5s và log, **không treo**.
- [x] Đơn `paid` không bao giờ bị sweeper expire.
- [x] Chỉ **một** cột quyết định "đã xử lý"; claim query và index dùng cùng predicate.
- [x] `audit_log.summary` không chứa đơn giá; đọc audit cần `ops_admin` + scope.
- [x] Thêm `OutboxHandler` thứ hai chỉ cần 1 file + 1 dòng binding — chứng minh bằng một handler log-only trong test.
- [x] ADR 0017 nêu rõ at-least-once + không đảm bảo thứ tự + đường đổi sang broker ngoài.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| Xử lý trùng khi nhiều instance | `FOR UPDATE SKIP LOCKED` cho relay; use case idempotent cho sweeper; test #2, #11 |
| **Mất event khi crash** | Claim là row lock trong transaction chưa commit ⇒ crash nhả lock, event nguyên vẹn; test #3 |
| Consumer không idempotent ⇒ sai âm thầm | Contract trong interface doc + code-standards; consumer đầu làm mẫu bằng `UNIQUE`+`ON CONFLICT`; test #6 |
| Head-of-line blocking | `next_attempt_at` đẩy event lỗi ra sau; `dead` loại khỏi vòng poll; test #5 |
| **Transaction lồng nhau quay lại** | Job đọc id **ngoài** transaction; use case nhận `tx` từ job; `lock_timeout=5s` là lưới cuối; test #12 |
| Poll gây tải DB vô ích | Index riêng `where status='pending'`; interval mặc định 1s; batch giới hạn |
| Rò dữ liệu qua audit | `summary` là whitelist field, không phải payload thô; `org_id NOT NULL`; `ops_admin` + scope; test #14, #15 |
| Over-engineer thành message broker mini | Không làm: priority queue, DLQ riêng, fan-out, ordering đảm bảo. Giữ: poll, claim, dispatch, retry, dead |
