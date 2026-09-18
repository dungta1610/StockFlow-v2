---
phase: 9
title: "Web Foundation & Ops Console"
status: in-progress
priority: P1
dependencies: [5, 8]
---

# Phase 09: Web Foundation & Ops Console

> **Làm sớm theo yêu cầu (2026-09-18).** Người dùng cần UI để test Phase 00–04 nên phase này chạy trước 05/08, chia đợt:
> 1. ✅ Nền (router, query, api-client + refresh mutex giữa tab, theme) + login chọn org + **Orders** (buyer đặt đơn có báo giá; ops mark-paid/fulfill/cancel/expire; sổ cái của đơn). Test #1, #2 xanh.
> 2. Inventory (list, adjust, timeline sổ cái).
> 3. Catalog + bảng giá — **ngoài danh sách 4 màn**, thêm vì cần test Phase 02.
> 4. Orgs + users — **ngoài danh sách 4 màn**, thêm vì cần test Phase 01.
> Reservations, Copilot, audit timeline, e2e làm khi 05/08 xong.

> **Sửa sau red-team (MVP cut + SSE auth).** 7 màn → **4 màn**. Bỏ Dashboard (và endpoint `/ops/dashboard` bịa ra để phục vụ nó — một endpoint backend tính trong ngân sách frontend), bỏ Price-lists CRUD, bỏ Orgs & users CRUD. Giữ nguyên refresh mutex vì đó là bài học liên phase thật. 6→5 ngày.

## Overview

Frontend thật. Ops console là persona duy nhất ở v1 (buyer portal cắt sang v1.1). Đây là nơi 5 chương kỹ thuật trở nên *nhìn thấy được*: sổ cái tồn kho, vòng đời đơn, reservation sắp hết hạn, agent gọi tool.

**Phase này không được cắt thêm.** Nếu trễ, cắt độ bóng của UI, không cắt màn.

## Requirements

**Functional — 4 màn**

| Màn | Nội dung | Chương |
|---|---|---|
| **Inventory** | list + filter; detail có **timeline sổ cái** (before/after từng dòng) | 1 |
| **Orders** | list + filter; detail có **state machine trực quan** + reservation của đơn + timeline sự kiện (từ `audit_log`) + nút mark-paid/fulfill/cancel | 1, 3 |
| **Reservations** | sắp hết hạn trong N phút; expire thủ công | 1, 3 |
| **Copilot** | chat SSE, **badge tool theo thời gian thực**, card đề xuất có nút Duyệt/Từ chối | 5 |

Không có Dashboard. Trang gốc điều hướng thẳng vào Orders — với 4 màn thì một trang tổng hợp chỉ là thêm một endpoint và một nguồn sai lệch.

**Non-functional**
- Access token trong memory; refresh token trong cookie theo quyết định **Phase 01** (`HttpOnly; Secure; SameSite=Strict; Path=/auth` — cookie phải tới được cả `/auth/refresh` lẫn `/auth/logout`, xem ADR 0009). Frontend **không** tự quyết chuyện này.
- Refresh được tuần tự hoá **giữa các tab**, không chỉ trong một tab (xem §Refresh mutex).
- **Token không bao giờ trong URL.** SSE dùng `fetch` + `ReadableStream` (gửi được header `Authorization`), **không** dùng `EventSource`.
- Tự refresh khi 401, có **mutex** chống refresh đồng thời.
- Empty / error / loading state cho **mọi** màn.
- Dark/light mode.
- Type an toàn đầu-cuối từ `packages/contracts`; không khai lại type ở FE.
- Không horizontal scroll ở 375px / 768px / 1440px.

## Architecture

```
apps/web/src/
├── main.tsx · app.tsx
├── lib/
│   ├── api-client.ts        # auth header · refresh mutex · error envelope → ApiError
│   ├── sse.ts               # fetch + ReadableStream, KHÔNG EventSource
│   ├── query-client.ts
│   └── auth-store.ts        # token in-memory + refresh mutex
├── routes/                  # TanStack Router
│   ├── _authed.tsx          # layout + guard
│   ├── _authed/orders/{index,$id}.tsx
│   ├── _authed/inventory/{index,$id}.tsx
│   ├── _authed/reservations.tsx
│   ├── _authed/copilot.tsx
│   └── login.tsx
├── features/                # theo domain, không theo kiểu file
│   ├── orders/{hooks,components}     # order-state-machine.tsx, reservation-list.tsx
│   ├── inventory/{hooks,components}  # ledger-timeline.tsx
│   ├── copilot/{hooks,components}    # chat-stream.tsx, tool-call-badge.tsx, proposal-card.tsx
│   └── auth/
└── components/ui/           # shadcn — primitive, không logic nghiệp vụ
```

`features/` theo domain vì cùng lý do backend chia theo module: sửa một tính năng thì mọi thứ liên quan nằm cạnh nhau. Thêm buyer portal ở v1.1 chỉ là thêm `features/catalog/`, `features/cart/` — và đó cũng là phép thử cấu trúc này có đúng không.

### Refresh mutex — bài học liên phase, giữ nguyên

Thiếu mutex thì 5 request song song gặp 401 sẽ gọi refresh 5 lần. Với **refresh token xoay vòng + phát hiện tái sử dụng** (Phase 01), 4 lần sau bị coi là tái sử dụng ⇒ **thu hồi cả family** ⇒ user bị đăng xuất ngẫu nhiên. Đây là loại bug chỉ lộ ra khi hai phase gặp nhau, và nó đáng giữ vì chính nó dạy bài học đó.

```ts
// lib/api-client.ts
// 1. error envelope { error: {code,message,details} } → ApiError giữ nguyên code
// 2. 401 → refresh MỘT LẦN; các request đồng thời chờ chung một promise
// 3. refresh fail → xoá token, điều hướng /login
// 4. mọi response parse qua zod schema từ packages/contracts
```

**Giữa các tab** (quyết định sau review Phase 01): mutex trong một tab chưa đủ. Hai tab cùng hết hạn access token sẽ gửi cùng một refresh token; server để đúng một request thắng và **thu hồi cả họ** (đã chứng minh bằng `test/verification/concurrent-refresh.spec.ts`), nên cả hai tab bị đăng xuất. Cách xử lý đã chọn là ở phía client, không nới server:

- Bọc lời gọi refresh trong `navigator.locks.request('sf-refresh', …)` (Web Locks API) — mọi tab cùng origin xếp hàng.
- Tab thứ hai, sau khi lấy được lock, **kiểm lại** trước khi gọi: nếu tab khác vừa refresh xong (phát qua `BroadcastChannel('sf-auth')` kèm access token mới) thì dùng luôn, không gọi refresh nữa.
- Không chọn "cửa sổ ân hạn" phía server (cho phép dùng lại token trong vài giây): làm vậy thì token bị đánh cắp dùng trong cửa sổ đó sẽ không bị phát hiện.

### SSE — không `EventSource`

`EventSource` không gửi được header, nên đường mặc định là nhét token vào query string — nơi nó rơi vào logging interceptor của Phase 00 và mọi proxy. Dùng `fetch` + `ReadableStream` + parser SSE tự viết (~60 dòng), gửi `Authorization` bình thường, và `AbortController` cho nút Stop.

Stream mang `RunEvent` từ Phase 07: `text`, `tool_start`, `tool_end`, `error`.

### Hai màn đáng khoe

**Orders detail** — vẽ state machine bằng SVG/CSS: tô đậm trạng thái hiện tại, làm mờ đường không đi được. **Chỉ vẽ 5 trạng thái v1 sinh ra** (`reserved`, `paid`, `fulfilled`, `cancelled`, `expired`); ba trạng thái còn lại trong enum không có người tạo nên không render (xem Phase 04). Cạnh đó là timeline sự kiện từ `audit_log` — và vì `audit_log.summary` đã lọc bỏ đơn giá (Phase 05), timeline an toàn để hiển thị.

**Copilot** — badge tool là chi tiết khiến copilot đáng tin: người vận hành **thấy** nó tra cứu gì chứ không phải bịa. Đề xuất điều chỉnh hiện thành card có nút Duyệt/Từ chối ngay trong luồng chat; nút Duyệt chỉ hiện với `ops_admin` (Phase 08).

## Related Code Files

**Create**
- `apps/web/src/**`
- `apps/web/{vite.config.ts,tailwind.config.ts,components.json}`
- `apps/web/.env.example` — `VITE_API_URL`
- `apps/web/e2e/` — Playwright, 2 kịch bản
- `docs/adr/0025-spa-over-ssr.md`

**Modify**
- `packages/contracts/src/index.ts` — export đủ schema cho FE
- `apps/api/src/main.ts` — CORS cho origin web
- `docker-compose.yml` — service web

**Reference (read-only)**
- `AI-Harness-Clone/apps/web/src/api/sse.ts` — pattern parse SSE (nhưng **không** copy `EventSource` nếu có)
- `AI-Harness-Clone/apps/web/src/components/{message-list.tsx,composer.tsx}` — bố cục chat

## Tests First (TDD — lỏng)

UI không TDD từng màn. Viết trước đúng chỗ có logic thật:

1. `web/api-client.spec.ts` — error envelope → `ApiError` giữ `code`; 401 → refresh rồi retry nguyên request.
2. **`web/refresh-mutex.spec.ts`** — 5 request song song cùng gặp 401 ⇒ endpoint refresh gọi **đúng một** lần, cả 5 retry thành công.
3. **`web/sse-client.spec.ts`** — parse đúng `text`/`tool_start`/`tool_end`/`error`; nút Stop huỷ stream qua `AbortController`; mất kết nối ⇒ hiện lỗi chứ không treo im lặng. **Assert `Authorization` đi trong header và URL không chứa token.**
4. `web/order-state-machine.spec.tsx` — render đúng trạng thái hiện tại và đường hợp lệ cho **5 trạng thái v1**; 3 trạng thái không có producer thì không render.
5. `web/contracts-sync.spec.ts` — response thật của API parse lọt qua zod của `packages/contracts` (chạy với API đang chạy).

**E2E (Playwright), 2 kịch bản:**
- `e2e/ops-order-lifecycle.spec.ts` — login ops → mở đơn → cancel → xác nhận tồn kho trên UI đã trả về.
- `e2e/copilot-proposal.spec.ts` — login `ops_admin` → hỏi copilot tồn kho → nhận đề xuất → duyệt → xác nhận tồn kho đổi.

## Implementation Steps

1. Scaffold: Vite + React + TS + Tailwind + shadcn + TanStack Router/Query. ADR 0025.
2. Viết 5 test + 2 e2e — đỏ.
3. `lib/api-client.ts` + `lib/auth-store.ts` với refresh mutex. Test #1, #2 xanh.
4. `lib/sse.ts` — `fetch` + `ReadableStream` + parser. Test #3 xanh.
5. Layout + nav + theme toggle + `_authed` guard + màn login.
6. **Chốt bộ primitive shadcn ở đây** (button, input, table, dialog, badge, skeleton, toast, select) — không thêm dần ad-hoc từng màn.
7. Orders: list + detail (state machine, reservations, timeline, nút hành động). Test #4 xanh.
8. Inventory: list + detail có timeline sổ cái.
9. Reservations: sắp hết hạn + expire thủ công.
10. Copilot: chat SSE + badge tool + card đề xuất (nút Duyệt chỉ cho `ops_admin`).
11. **Rà empty/error/loading state từng màn** — bước riêng, không làm lẫn vào lúc dựng màn; làm lẫn thì luôn bị bỏ sót.
12. E2E xanh; test #5 xanh với API đang chạy.

## Success Criteria

- [ ] 5 test + 2 e2e xanh.
- [ ] 5 request song song gặp 401 ⇒ refresh gọi đúng 1 lần, không ai bị đăng xuất oan.
- [ ] Hai tab cùng hết hạn access token ⇒ refresh gọi đúng 1 lần **trên toàn origin**, cả hai tab tiếp tục làm việc (e2e mở 2 tab).
- [ ] **Không request nào mang token trong URL** (assert trong test #3 và rà thủ công tab Network).
- [ ] Cả 4 màn có đủ empty / error / loading state.
- [ ] Copilot hiện badge tool theo thời gian thực; duyệt đề xuất ngay trong chat và thấy tồn kho đổi.
- [ ] Order detail vẽ đúng state machine **5 trạng thái** + timeline sự kiện.
- [ ] Inventory detail hiện timeline sổ cái với before/after từng dòng.
- [ ] Dark/light hoạt động ở mọi màn.
- [ ] Không horizontal scroll ở 375 / 768 / 1440px.
- [ ] Không type API nào khai lại ở FE.
- [ ] `docker compose up` ⇒ web mở được, đăng nhập bằng user seed.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| **Scope creep** — 4 màn phình lại thành 7 | Bảng màn ở §Requirements là danh sách **đóng**. Ý tưởng mới ghi vào `plans/` cho v1.1 |
| Refresh mutex thiếu ⇒ đăng xuất ngẫu nhiên do rotation Phase 01 | Test #2 viết trước; bug liên phase đã được gọi tên ở §Architecture |
| Token rơi vào log qua URL | Không dùng `EventSource`; test #3 assert header; Phase 01 đã chốt nguyên tắc |
| Empty/error state bị bỏ sót | Bước 11 là bước riêng có checklist |
| FE và API lệch âm thầm | `packages/contracts` là nguồn duy nhất; test #5 chạy với API thật |
| Chat SSE rò connection khi rời trang | `AbortController` trong cleanup `useEffect`; test #3 phủ Stop và mất kết nối |
| **Phase 07 phải bỏ streaming** | Badge tool và test #3 phần tool cùng bị cắt; copilot hiển thị kết quả JSON. Quyết định ghi lại, không âm thầm để hỏng |
| Làm đẹp quá đà | UI đủ tử tế là đạt. Ngân sách polish: bước 11, không hơn |
