---
phase: 10
title: "Buyer Portal"
status: cancelled
priority: P3
dependencies: [9]
---

# Phase 10: Buyer Portal — **CANCELLED**

> Cắt ngày 2026-09-17 sau red-team. File giữ lại làm hồ sơ lý do và làm bản thiết kế sẵn cho v1.1.

## Vì sao cắt

**1. Không thuộc chương nào trong 5 chương kỹ thuật.** Nó là bề mặt trình bày, không phải bài học kiến trúc. Mục tiêu bạn chốt là *học sâu kiến trúc + AI*, và 3 ngày ở đây không dạy thêm gì mà Phase 09 chưa dạy.

**2. Chính plan đầu đã đề cử nó là ứng viên cắt đầu tiên** — cắt ngay bây giờ tốt hơn cắt lúc đã trễ, vì bây giờ còn gỡ được cả những phụ thuộc ngược mà nó tạo ra.

**3. Hai thứ nó trưng bày đã nhìn thấy được trong ops console:** giá hợp đồng theo org (Phase 02 + màn Orders detail) và reservation/hạn giữ hàng (Phase 09 màn Reservations).

**4. Nó mang **thay đổi contract duy nhất chưa được cấp giờ** trong cả plan:** `ResolvedPrice` phải thêm `minQtyApplied`. *(Giữ lại: field này đã được đưa vào `ResolvedPrice` ở Phase 02 vì nó rẻ và giúp copilot giải thích được giá — nhưng nó không còn là nợ ẩn của một phase chưa làm.)*

## Điều đã giữ lại từ thiết kế này

Ba quyết định của Phase 10 vẫn có giá trị và đã được hấp thụ chỗ khác:

| Quyết định | Nơi giữ |
|---|---|
| `ResolvedPrice.minQtyApplied` — nói được "mua thêm 3 cái nữa xuống giá 40.000" | Phase 02, dùng cho `get_contract_price` của copilot |
| Giỏ hàng **không lưu giá**, mọi giá từ server | Nguyên tắc chung trong `code-standards.md` (cùng gốc với "DTO không khai `unit_price`") |
| `INSUFFICIENT_STOCK` là đường bình thường, không phải ngoại lệ hiếm | Phase 04 trả lỗi có cấu trúc `{productId, sku, requested, available}` để UI bất kỳ dùng được |

## Bản thiết kế cho v1.1

**5 màn:** Catalog (giá hợp đồng của org đang đăng nhập, badge bậc số lượng) · Product detail · Cart · Checkout · My orders.

**Endpoint cần thêm:** `POST /catalog/quote` — nhận `{items:[{productId,qty}], warehouseId}`, trả giá đã resolve + `minQtyApplied` + subtotal/total. Dùng chính `PriceResolver`, nên giá ở giỏ **bằng đúng** giá lúc đặt.

**Ba điểm dễ sai, ghi sẵn:**
1. Giỏ lưu `{productId, qty}` trong `localStorage`, **không lưu giá** — bậc số lượng đổi theo `qty`, FE tự suy sẽ tạo nguồn sự thật thứ hai.
2. `quote` **không giữ hàng.** Giá và tồn có thể đổi giữa lúc xem giỏ và lúc đặt. UI phải coi `INSUFFICIENT_STOCK` là đường bình thường và cho sửa giỏ tại chỗ. Muốn giữ hàng ở bước giỏ thì phải làm cả cơ chế giữ chỗ giỏ hàng — ngoài scope.
3. Idempotency key sinh **một lần khi vào màn checkout** và giữ nguyên qua mọi lần thử lại; Phase 04 đã đảm bảo thử lại sau `INSUFFICIENT_STOCK` với cùng key vẫn thành công.

**Cấu trúc:** thêm `routes/_buyer*` + `features/{catalog,cart,buyer-orders}/`, tái dùng toàn bộ `lib/` và `components/ui/` từ Phase 09. Điều hướng theo `Actor.orgType`: `internal` → ops console, `buyer` → buyer portal. Một app, hai persona.

Nếu Phase 09 dựng đúng, phase này gần như chỉ là thêm `features/` — đó cũng là phép thử xem cấu trúc Phase 09 có đúng hay không.
