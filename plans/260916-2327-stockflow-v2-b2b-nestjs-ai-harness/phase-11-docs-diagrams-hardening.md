---
phase: 11
title: "Hardening, Docs & Diagrams"
status: pending
priority: P2
dependencies: [9]
---

# Phase 11: Hardening, Docs & Diagrams

> **Sửa sau red-team (finding #15 + MVP cut).** Bỏ `operations.md` và hai "chỉ báo" kiểm bằng commit thử nghiệm rồi `git diff` — đó là nghi thức, không phải kiểm chứng. `verify-architecture.sh` bản đầu có 4 lỗi khiến nó **pass rỗng**; bản này sửa và có test cho chính nó. Giữ `decisions-vs-stockflow.md` nguyên vẹn — artifact giá trị nhất của cả plan cho mục tiêu học. 2→3 ngày.

## Overview

Mục tiêu project là **học sâu kiến trúc** — bài học không viết ra thì sáu tháng sau không còn là bài học. Phase này hợp nhất ADR đã viết rải rác, vẽ kiến trúc, và chạy các **gate kiểm chứng thật sự chạy được**.

ADR **không** viết ở đây — chúng đã viết ngay tại phase phát sinh quyết định (0001→0025). Ở đây chỉ hợp nhất, đối chiếu với thực tế, và sửa cái nào đã bị thực tế phủ nhận.

## Requirements

**Functional**
- `docs/system-architecture.md` — kiến trúc **thật**, không phải kiến trúc mong muốn.
- `README.md` — quickstart chạy được đúng từng lệnh trên máy sạch.
- `docs/decisions-vs-stockflow.md` — đối chiếu với repo Go: port nguyên gì, cố ý sửa gì, vì sao.
- Diagram: sơ đồ thành phần, luồng tạo đơn, luồng outbox, luồng copilot.
- `docs/adr/` đủ 25 bản + index.
- `scripts/verify-architecture.sh` — chạy được, exit code có nghĩa.

**Non-functional**
- Mọi chỉ báo kiến trúc **chạy được như script**. Cái nào không script được thì **không đưa vào danh sách** — bản đầu để 2/5 là thao tác tay rồi vẫn đòi "tất cả phải scripted".
- Toàn bộ acceptance criteria (9 mục) xác minh lại trên máy sạch.

## Architecture

```
docs/
├── system-architecture.md      # 5 chương · ranh giới · invariant
├── code-standards.md           # đã viết từ P00, rà cho khớp thực tế
├── decisions-vs-stockflow.md   # đối chiếu repo Go  ← artifact giá trị nhất
├── adr/0001..0025 + index.md
└── diagrams/                   # nguồn + SVG
scripts/verify-architecture.sh
```

### `system-architecture.md` — mỗi chương ba câu

Mỗi mục trả lời đúng: **bất biến là gì**, **enforce ở đâu**, **đánh đổi là gì**.

| Chương | Bất biến | Enforce ở |
|---|---|---|
| Concurrency & transaction | không oversell; mọi đổi tồn kho đều có vết sổ cái; transaction không lồng nhau | conditional UPDATE + `CHECK >= 0` + `tx: Tx` tường minh + test #1 P04 |
| Pricing as policy engine | giá luôn từ server; nguồn giá truy vết được | `PriceResolver` port + `price_list_item_id` + DTO không khai field giá |
| Outbox & eventual consistency | state change và event cùng tx; một nguồn sự thật; consumer idempotent | `UNIQUE event_id` + claim bằng row lock + `SKIP LOCKED` + test P05 |
| Multi-tenant boundary | buyer không rò sang nhau; ops đọc rộng **qua `OrgScope`**, không qua bypass | `scope: OrgScope` bắt buộc trong port + namespace trong mọi statement `MemoryStore` + tenant trên `chat_sessions` |
| Agent over domain tools | agent không có quyền cao hơn user | tool factory nhận `Actor`; schema tool **không khai tenant**; ESLint chặn import; test P08 |

### `decisions-vs-stockflow.md` — bảng đối chiếu

| Khía cạnh | StockFlow (Go) | v2 | Vì sao |
|---|---|---|---|
| Kiến trúc module | `model/biz/storage/transport` | `domain/application/infrastructure/http` | Giữ triết lý, đổi từ vựng cho khớp TS/Nest |
| Interface theo use case | `CreateOrderStore` | port cùng tên | Giữ — điểm mạnh nhất của repo cũ |
| Tạo đơn | không chạm tồn kho | reserve nguyên tử cùng tx | Bất biến lõi của e-commerce |
| Cancel/expire | chỉ đổi status | release + ghi sổ cái, **toàn bộ dòng của đơn** | Không có nó thì vá reserve xong sẽ rò kho |
| Giá | client gửi `unit_price` | `PriceResolver` phía server | Buyer đặt `unit_price: 0` là mua free |
| Tiền | `float64` | `numeric(18,2)` + minor units, **một currency** | Float không dùng được cho tiền |
| Migration | không có | `db/migrations/` đánh số | Repo cũ không dựng lại DB được |
| Auth | không có | JWT + refresh xoay vòng + RBAC + **`OrgScope`** | Mọi endpoint repo cũ đều public |
| Test | 0 file | Vitest + testcontainers; invariant có test riêng | Bất biến không test được thì chỉ là lời hứa |
| Outbox | README mô tả, source không có | relay thật + consumer thật | Seam đòn bẩy cao nhất |
| `order_code` | `RANDOM()` 6 số + `UNIQUE` | sequence theo ngày | Va chạm là chuyện sớm muộn |
| Khoá tồn kho | `FOR UPDATE` cho adjust (**không khoá gì khi row chưa tồn tại**) | upsert nguyên tử cho adjust; conditional UPDATE cho reserve | Vá race tạo row đồng thời |
| Trạng thái đơn | 8 hằng số | enum giữ 8, **v1 chỉ sinh 5** | `pending`/`awaiting_payment`/`completed` không có người tạo |
| `inventory.version` | tăng nhưng không dùng | giữ để audit, **không** dùng làm optimistic lock ở v1 | Không để thành cargo cult |
| Multi-tenant | không có | org + RBAC + contract pricing | Không có nó thì không phải B2B |
| Payment | module riêng | **cắt**; `mark-paid` ops-only trong ordering | Không thuộc chương nào; bài học đã có chỗ khác |

### `scripts/verify-architecture.sh` — sửa 4 lỗi của bản đầu

Bản đầu: (a) dùng brace expansion `{application,http}` trong file `.sh` chạy bằng `sh` ⇒ grep một đường dẫn **không tồn tại** ⇒ gate pass rỗng; (b) regex tiền không quét `apps/web` dù `plan.md` nói "toàn repo", và bỏ sót `z.number()` trong `packages/contracts` — đúng ranh giới FE/BE mà nó định canh; (c) không `set -e`, không `exit 0` cuối ⇒ repo sạch thoát **1**; (d) 2/5 chỉ báo là thao tác tay.

```bash
#!/usr/bin/env bash
set -euo pipefail
fail=0
chk() { # chk <mô tả> <pattern> <path...>
  local desc="$1"; shift; local pat="$1"; shift
  if grep -rnE "$pat" "$@" 2>/dev/null; then echo "FAIL: $desc"; fail=1;
  else echo "ok: $desc"; fi
}

# 1. copilot không chạm SQL (liệt kê thư mục tường minh, không brace expansion)
chk "copilot: no SQL" "SELECT|INSERT|UPDATE|DELETE" \
    apps/api/src/modules/copilot/application apps/api/src/modules/copilot/http
# 2. ai-harness không biết apps/
chk "ai-harness: no apps import" "from ['\"].*apps/" packages/ai-harness/src
# 3. platform không import modules
chk "platform: no modules import" "from ['\"].*modules/" apps/api/src/platform
# 4. không float biểu diễn tiền — TOÀN repo, gồm web và contracts
chk "money: no float" "(price|amount|total|subtotal|unitPrice|lineTotal)\s*:\s*number|z\.number\(\)\s*(//.*)?\s*$" \
    apps/api/src apps/web/src packages
# 5. không còn trạng thái 'releasing'
chk "ordering: no 'releasing' state" "releasing" apps/api/src/modules/ordering

exit $fail
```

Chỉ báo #4 sẽ có false positive với `z.number()` dùng cho `qty`. Xử lý bằng cách bắt buộc mọi số nguyên không phải tiền dùng `z.number().int()` và loại pattern đó — ghi rule vào `code-standards.md` thay vì nới lỏng gate.

**Hai chỉ báo bỏ khỏi script** (bản đầu kiểm bằng commit thử nghiệm + `git diff`): "thêm resolver giá không đụng ordering" và "thêm tool copilot không đụng ai-harness". Chúng **đã được chứng minh bằng test thật** ở Phase 02 và Phase 08 (success criteria yêu cầu thêm một resolver/tool thật trong test). Kiểm hai lần bằng nghi thức git là thừa.

## Related Code Files

**Create**
- `docs/system-architecture.md`, `docs/decisions-vs-stockflow.md`
- `docs/adr/index.md`
- `docs/diagrams/*` (nguồn + SVG)
- `scripts/verify-architecture.sh`
- `README.md`

**Modify**
- `docs/code-standards.md` — rà cho khớp thực tế; thêm rule `z.number().int()` cho số không phải tiền
- `.env.example` — rà đủ biến, mỗi biến một dòng mô tả
- `docker-compose.yml` — rà healthcheck, thứ tự phụ thuộc

## Gate (không TDD, nhưng phải chạy được)

1. `scripts/verify-architecture.sh` exit **0**.
2. `bash -n scripts/verify-architecture.sh` (syntax) **và** một lần chạy có chủ đích trên repo đã cố tình vi phạm ⇒ exit **1**. *(Gate cho chính cái gate — bản đầu pass rỗng.)*
3. Quickstart README chạy đúng từng lệnh trên môi trường xoá sạch (`docker compose down -v`, xoá `node_modules`).
4. Toàn bộ suite xanh, gồm test concurrent Phase 04 **lặp 10 lần**.

## Implementation Steps

1. **Hardening trước, docs sau** — viết docs về hệ thống chưa rà là viết về hệ thống tưởng tượng:
   - Rà `.env.example` đủ và có mô tả.
   - Rà error code trả về nhất quán giữa các module.
   - `EXPLAIN` cho mọi truy vấn list có filter; bổ sung index còn thiếu.
   - Rà rate limit đã áp lên login và copilot.
   - Xoá code chết, TODO đã xong, tool/màn không dùng.
2. Viết `scripts/verify-architecture.sh`, chạy, **sửa mọi vi phạm phát hiện được**. Rồi cố tình vi phạm một cái để chứng minh gate đỏ được (gate #2).
3. `docker compose down -v`, chạy lại quickstart từ đầu **theo đúng README đang viết**; sửa README cho khớp thực tế.
4. Chạy lại 9 acceptance criteria, tick từng cái.
5. `docs/system-architecture.md` — 5 chương, mỗi chương ba câu như bảng §Architecture.
6. Diagram: sơ đồ thành phần · luồng tạo đơn 7 bước · luồng outbox (claim bằng row lock) · luồng copilot (tool → service → DB).
7. `docs/decisions-vs-stockflow.md` — hoàn thiện bảng §Architecture bằng dữ kiện thật từ commit.
8. `docs/adr/index.md` + rà 25 ADR: cái nào đã bị thực tế phủ nhận thì **sửa ADR**, không im lặng. Ghi thêm mục "Red team đã đổi quyết định nào" để người đọc thấy được đường đi.
9. README: mô tả, kiến trúc tóm tắt, quickstart, cấu trúc repo, **và mục "những gì cố ý không làm và vì sao"** (payment, buyer portal, multi-currency, RLS, deploy) — mục này nói nhiều về kỹ năng kỹ thuật hơn cả danh sách feature.

## Success Criteria

- [ ] `scripts/verify-architecture.sh` exit 0 trên repo sạch **và** exit 1 khi có vi phạm cố ý.
- [ ] Quickstart README chạy đúng trên môi trường xoá sạch, không bước ngoài tài liệu.
- [ ] Toàn bộ 9 acceptance criteria xác minh lại và tick.
- [ ] Test concurrent Phase 04 chạy 10 lần liên tiếp đều xanh.
- [ ] `docs/system-architecture.md` đủ 5 chương, mỗi chương nêu bất biến / enforce ở đâu / đánh đổi.
- [ ] `docs/decisions-vs-stockflow.md` liệt kê đủ mọi khác biệt cố ý so với repo Go, **gồm cả những thứ đã cắt**.
- [ ] 25 ADR tồn tại, có index, không ADR nào mâu thuẫn với code thực tế.
- [ ] README có mục "cố ý không làm và vì sao".

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| **Docs mô tả kiến trúc mong muốn thay vì kiến trúc thật** | Bước 1–3 (hardening + verify + rebuild sạch) làm **trước** dòng docs nào |
| **Gate pass rỗng** (lỗi của bản đầu) | Gate #2 bắt buộc chứng minh script đỏ được khi có vi phạm |
| README có bước ngầm chỉ tác giả biết | Bước 3 xoá sạch môi trường và chạy đúng theo README |
| ADR đã bị thực tế phủ nhận vẫn nằm đó | Bước 8 rà từng ADR; phủ nhận thì sửa, không bỏ qua |
| Phase bị coi là "dọn dẹp" và làm qua loa | Với mục tiêu học sâu, đây là phase **biến công sức thành tài sản**. Không có nó thì sáu tháng sau chỉ còn một repo |
| Diagram lỗi thời ngay khi code đổi | Ít diagram nhưng đúng; nguồn trong repo, không phải ảnh dán từ công cụ ngoài |
| Phát hiện vi phạm kiến trúc muộn ở bước 2 | Sửa ở đây vẫn rẻ hơn phát hiện sau khi quên ngữ cảnh. Vi phạm lớn ⇒ ghi thành mục "nợ kỹ thuật" trong docs thay vì giấu |
