---
phase: 6
title: "Payment (Simulated)"
status: cancelled
priority: P3
dependencies: [4]
---

# Phase 06: Payment (Simulated) — **CANCELLED**

> Cắt ngày 2026-09-17 sau red-team. File giữ lại làm hồ sơ lý do — đó là thứ đáng giá cho mục tiêu học, và để nếu sau này muốn khôi phục thì không phải suy luận lại từ đầu.

## Vì sao cắt

**1. Không thuộc chương nào trong 5 chương kỹ thuật.** Đối chiếu bảng chương ở `plan.md`: concurrency (03,04), pricing (02), outbox (05), tenant boundary (01), agent-over-tools (07,08). Payment không nằm ở đâu.

**2. Ba bài học nó tuyên bố dạy đều đã có chỗ khác:**

| Bài học | Đã dạy ở |
|---|---|
| Idempotency | Phase 04 — và ở đó nó **khó hơn** (claim ở transaction riêng, ba trạng thái, giải phóng key khi lỗi nghiệp vụ) |
| State machine | Phase 04 — vòng đời đơn hàng, hàm thuần, dùng chung bởi 4 luồng |
| Port/adapter | Phase 02 (`PriceResolver`), Phase 07 (`MemoryStore`, `AgentRuntime`, `LlmGateway`) |

**3. Red-team tìm thấy 1 Critical nằm gọn trong phase này** (finding #7): callback không xác thực, không ký, và công tắc `__simulate` gate bằng `NODE_ENV !== 'production'` — mà project **cố ý không bao giờ deploy**, nên guard đó vô hiệu theo thiết kế. Đường tấn công: đoán `payment_code` → POST callback → đơn thành `paid` không mất tiền → `paid` là terminal nên không cancel được và sweeper bỏ qua → **kho bị khoá vĩnh viễn**, đúng bất biến mà Phase 03–04 tốn 7 ngày xây.

Sửa cho đúng (HMAC, timestamp window, replay protection, tách cờ simulate khỏi `NODE_ENV`) tốn thêm ~1 ngày để bảo vệ một thứ **mô phỏng**. Cắt phase là cách rẻ hơn và trung thực hơn.

**4. Phase 04 vốn đã cần `markPaid`.** Test #4 và #11 của Phase 04 đều đòi một đơn ở trạng thái `paid`; với `markPaid` khai ở Phase 06, hai test đó chỉ pass được bằng cách chèn SQL thô — tức là test ma đi vòng qua chính state machine mà nó định chứng minh.

## Thay bằng gì

`POST /orders/:id/mark-paid` trong **Phase 04**: ops-only (`@Roles('ops','ops_admin')`), idempotent, `reserved → paid`, ghi outbox `order.paid`. Khoảng 60 dòng, và nó xoá được cả rủi ro ở mục 3 lẫn test ma ở mục 4.

## Khôi phục sau này (v1.1)

Nếu làm payment thật:
1. `PaymentGateway` port trong `modules/payment`: `createCharge`, `verifyCallback`. `verifyCallback` nằm **trong port** vì xác thực chữ ký là việc của từng cổng.
2. `POST /payments/callback` là `@Public()` **nhưng** bắt buộc HMAC trên raw body + cửa sổ timestamp ±5 phút + `UNIQUE (method, external_txn_id)` chống replay ở tầng DB.
3. Payment **không** tự UPDATE bảng `orders` — gọi `OrderService.markPaid` đã có từ Phase 04. Một aggregate, một chủ sở hữu.
4. Không có cờ simulate nào gate bằng `NODE_ENV`; dùng biến riêng mặc định tắt.

Schema tham chiếu (port từ `StockFlow/module/payment/`, đã có sẵn `idempotency_key` + `external_txn_id` — phần tốt nhất của repo cũ):

```sql
payments(id, order_id, payment_code unique, method, status, amount numeric(18,2),
         currency, idempotency_key, external_txn_id, paid_at, failed_at, …,
         unique (order_id, idempotency_key))
create unique index on payments (method, external_txn_id) where external_txn_id is not null;
```
