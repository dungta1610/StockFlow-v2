---
phase: 0
title: "Foundation, Platform & Spike"
status: in-progress
priority: P1
dependencies: []
---

# Phase 00: Foundation, Platform & Spike

> **Sửa sau red-team (finding #4, #5, #6, #12, #15 + rủi ro #8).** Phase này phình từ 2–3 lên **4–5 ngày** vì nó nhận thêm bốn thứ mà plan đầu để rơi: Redis + rate limiter, hợp đồng transaction tường minh, chiến lược test isolation, và quyết định tooling monorepo. Spike Bedrock cũng mở rộng để chứng minh **tool lifecycle event** — đòn bẩy cao nhất của cả plan.

## Thực tế đã build (2026-09-17)

Phần thiết kế bên dưới giữ nguyên để thấy đường đi. Những chỗ build khác đi, và vì sao:

| Thiết kế | Đã build | Lý do / nơi ghi |
|---|---|---|
| Tiêu thụ package bằng **source** ở mọi nơi | API dùng **bản build** `packages/contracts/dist`; test và web dùng source qua alias | Node không chạy `.ts`, `tsc` không viết lại `paths` — ADR 0005 |
| `.eslintrc.cjs` | `eslint.config.mjs` (flat config) | ESLint 9 bỏ cấu hình cũ |
| `vitest.config.ts` ở gốc repo | `apps/api/vitest.config.ts` | Test nằm trong `apps/api`; web sẽ có config riêng — ADR 0006 |
| `logging.interceptor.ts` + `request-id.middleware.ts` | Một `request-logging.middleware.ts` | Interceptor không chạy khi guard từ chối ⇒ 401/403/429 mất request id |
| `scripts/spike-bedrock.ts` | `scripts/spike-bedrock.mts` | Strands SDK là ESM thuần |
| `platform/outbox/` trong cây thư mục | Chưa tạo | Thuộc Phase 05 |
| Cổng 5432 / 6379 / 4000 / 3000 | 5433 / 6380 / 4001 / 3100, **chỉ nghe trên 127.0.0.1** | Máy dev có project khác giữ cổng; stack có tài khoản demo mật khẩu công khai |
| Pool không bắt lỗi kết nối rảnh | `pool.on('error')` + `restart: unless-stopped` | Review: Postgres restart làm sập API — `test/platform/database-resilience.spec.ts` |
| Migrator chỉ ghi tên file | Ghi thêm **checksum**; sửa migration đã chạy ⇒ từ chối | Review L10 |

Hai tiêu chí spike Bedrock **chưa đạt**: máy chưa có AWS credential (ADR 0003).

## Overview

Dựng móng monorepo chạy được end-to-end, cộng **gỡ ba rủi ro lớn nhất ngay tuần đầu**: Bedrock có truy cập được không, Strands có phát tool event không, và test concurrency có chạy ổn định trên Windows không.

## Requirements

**Functional**
- `docker compose up` trên máy sạch ⇒ postgres(pgvector) + redis + litellm khoẻ, API trả `/health` ok.
- Migration runner chạy `db/migrations/*.sql` theo thứ tự, idempotent, ghi version đã apply.
- Error envelope `{error:{code,message,details}}` + `x-request-id` trên mọi response.
- Rate limiter Redis dùng được theo **key tuỳ biến** (IP, userId, orgId) — không chỉ IP như bản Go.
- **Spike:** chat + embedding qua Bedrock, **và một tool call thật phát event quan sát được**.

**Non-functional**
- 12-factor: config qua env, validate bằng zod khi boot, fail-fast.
- Mọi transaction chạy **READ COMMITTED** đặt tường minh, `lock_timeout=5s`, `statement_timeout=15s`.
- Test suite chạy một lệnh, dùng testcontainers, **cấu hình parallelism tường minh**.

## Architecture

```
stockflow-v2/
├── apps/
│   ├── api/src/
│   │   ├── platform/            # hạ tầng thuần — KHÔNG biết gì về domain
│   │   │   ├── config/          # env.schema.ts (zod) + config.module.ts
│   │   │   ├── database/        # pool · unit-of-work.ts · tx.ts
│   │   │   ├── redis/           # redis client            ← thêm sau red-team
│   │   │   ├── ratelimit/       # limiter theo key tuỳ biến ← thêm sau red-team
│   │   │   ├── outbox/          # CƠ CHẾ relay thuần (không routing domain)
│   │   │   ├── errors/          # all-exceptions.filter.ts, error-codes.ts
│   │   │   ├── observability/   # logging.interceptor.ts, request-id
│   │   │   ├── validation/      # zod-validation.pipe.ts
│   │   │   └── health/
│   │   ├── modules/             # (rỗng ở phase này)
│   │   └── main.ts
│   └── web/                     # Vite + React scaffold
├── packages/{contracts,ai-harness}/
├── db/migrations/001_schemas.sql
├── config/litellm/config.yaml
├── scripts/{migrate.ts,spike-bedrock.ts}
├── vitest.config.ts             ← thêm sau red-team
└── docs/{code-standards.md,adr/}
```

### Ranh giới `platform/` — sửa finding #12

Plan đầu tự đá nhau: P00 cấm `platform/**` import `modules/**` **và** đặt đó thành success criterion, rồi P05 lại đặt `reservation-expiry.job.ts` và outbox dispatcher (routing `order.*`) vào `platform/`. Không compile được.

Quy tắc chuẩn hoá:

| Thuộc `platform/` | Thuộc `modules/` |
|---|---|
| **Cơ chế**: relay poll/claim/retry, scheduler runner, limiter, pool | **Chính sách**: event nào gọi handler nào, job nào chạy logic gì |
| `OutboxRelay` (không biết `order.created` là gì) | `OutboxDispatcher` bindings, `ReservationExpiryJob` |

ESLint:
```jsonc
"apps/api/src/platform/**":        cấm import "**/modules/**"
"apps/api/src/modules/copilot/**": cấm import "**/infrastructure/**", "pg"
"packages/ai-harness/**":          cấm import "apps/api/**"
```

### `UnitOfWork` + `Tx` — sửa finding #5, #6 (D3)

Plan đầu để use case tự mở transaction, rồi P05 gọi use case **từ trong** một transaction khác → hai connection, chờ lock chéo, treo vĩnh viễn mà Postgres không phát hiện được (một cạnh của vòng nằm ở tầng app).

Sửa: **transaction là tham số, không phải hiệu ứng ngầm.**

```ts
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable'

export interface Tx {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface UnitOfWork {
  /** Mở transaction mới. Mặc định READ COMMITTED. */
  withTransaction<T>(fn: (tx: Tx) => Promise<T>, opts?: { isolation?: IsolationLevel }): Promise<T>
}
```

Quy tắc, ghi vào `code-standards.md`:
- **Mọi use case nhận `tx: Tx` làm tham số.** Không use case nào tự gọi `withTransaction`.
- Người mở transaction là **controller** (một request = một tx) hoặc **job** (một đơn vị việc = một tx).
- Không AsyncLocalStorage, không propagation ngầm, không savepoint lồng nhau. Ranh giới nhìn thấy trong chữ ký hàm.

Mỗi connection khi checkout khỏi pool chạy:
```sql
SET lock_timeout = '5s';
SET statement_timeout = '15s';
SET default_transaction_isolation = 'read committed';
```
READ COMMITTED là mức mà conditional UPDATE của Phase 04 an toàn. Ở REPEATABLE READ nó ném `40001` và cần retry tầng app — ta **không** đi đường đó, và ADR ghi rõ vì sao cùng với cái giá nếu ai đó đổi.

### Test isolation — sửa finding #15

Plan đầu nói "một container dùng chung, truncate giữa test" nhưng không cấu hình Vitest, mà Vitest mặc định chạy **song song theo file** → các file phá fixture của nhau, đúng kiểu flakiness mà mitigation nhắm tới, và trúng vào chính nhóm test concurrency quan trọng nhất.

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    fileParallelism: false,        // một file một lúc; container + truncate an toàn
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 120_000,          // lần pull image đầu tiên
    testTimeout: 60_000,
    setupFiles: ['apps/api/test/setup.ts'],
  },
})
```
Đổi lại là suite chạy chậm hơn. Đó là đánh đổi đúng: một test concurrency flaky tệ hơn không có test, vì nó làm mất niềm tin vào chính bất biến đắt nhất.

Pool Postgres của test đặt **≥60** (Phase 04 cần), container Postgres `max_connections=200` tường minh trong cấu hình testcontainer.

### Tooling monorepo — sửa rủi ro #8

Quyết ngay, không để trôi: `apps/api` là NestJS CJS + `emitDecoratorMetadata`; `apps/web` là Vite ESM/esbuild (**không** emit decorator metadata); `packages/ai-harness` ship decorator của Nest.

| Quyết định | Chọn |
|---|---|
| Tiêu thụ package | **Source**, qua `tsconfig` paths + Vite `resolve.alias`. Không build artifact, không tsup |
| `packages/contracts` | Zod thuần, **không** decorator ⇒ Vite ăn được |
| `packages/ai-harness` | Có decorator Nest ⇒ **chỉ** `apps/api` tiêu thụ, web không import |
| zod | Pin **một** version ở root; package khai `peerDependencies` |
| `reflect-metadata` | Import một lần ở `apps/api/src/main.ts` |

Hai version zod là cách im lặng nhất để `z.infer` gãy — pin ở root là bắt buộc, không phải tuỳ chọn.

### Migration

Runner đọc file theo **thứ tự tên**, so với `schema_migrations`, chạy cái chưa apply, mỗi file một transaction. Chỉ forward, không rollback (rollback = migration mới).

**Hệ quả với thứ tự phase:** số 001–010 gán cứng theo phase. Phase 07 chạy sớm sẽ apply `009` trước `002–008` ⇒ thứ tự applied lệch thứ tự tên vĩnh viễn, phá acceptance #8. Nếu muốn đảo vị phase, **đổi sang prefix timestamp trước**. Ghi vào ADR.

## Related Code Files

**Create**
- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc`, `.gitignore`, `.env.example`, **`vitest.config.ts`**
- `docker-compose.yml` — postgres(pgvector/pgvector:pg16) · redis:7 · litellm · api · web
- `config/litellm/config.yaml` — alias `default-chat` (Claude Haiku 4.5), `default-embed` (Cohere Embed Multilingual v3)
- `db/migrations/001_schemas.sql` — `CREATE SCHEMA commerce; CREATE SCHEMA ai; CREATE EXTENSION vector; CREATE EXTENSION citext;` + `schema_migrations`
- `scripts/migrate.ts`, **`scripts/spike-bedrock.ts`**
- `apps/api/src/platform/config/{env.schema.ts,config.module.ts}`
- `apps/api/src/platform/database/{database.module.ts,pool.ts,unit-of-work.ts,tx.ts}`
- **`apps/api/src/platform/redis/{redis.module.ts,redis.client.ts}`**
- **`apps/api/src/platform/ratelimit/{limiter.ts,rate-limit.guard.ts}`** — key tuỳ biến
- `apps/api/src/platform/errors/{all-exceptions.filter.ts,error-codes.ts,domain-error.ts}`
- `apps/api/src/platform/observability/{logging.interceptor.ts,request-id.middleware.ts}`
- `apps/api/src/platform/validation/zod-validation.pipe.ts`
- `apps/api/src/platform/health/health.controller.ts`
- `apps/api/src/{app.module.ts,main.ts}`
- `apps/api/test/{setup.ts,testcontainers.ts}`
- `apps/web/` — Vite + React + TS + Tailwind + shadcn init
- `packages/{contracts,ai-harness}/` — scaffold
- `docs/code-standards.md` — **mọi rule ranh giới ở §Architecture phải nằm đây từ ngày đầu**
- `docs/adr/0001-modular-monolith-with-ports.md`
- `docs/adr/0002-single-postgres-two-schemas.md`
- `docs/adr/0003-bedrock-region-models-and-tool-events.md`
- `docs/adr/0004-explicit-transaction-boundaries-and-isolation.md`
- `docs/adr/0005-monorepo-source-consumption-and-tooling.md`
- `docs/adr/0006-test-isolation-strategy.md`

**Reference (read-only)**
- `AI-Harness-Clone/apps/api/src/common/errors/all-exceptions.filter.ts`
- `AI-Harness-Clone/apps/api/src/common/observability/logging.interceptor.ts`
- `AI-Harness-Clone/apps/api/src/common/pipes/zod-validation.pipe.ts`
- `AI-Harness-Clone/apps/api/src/config/env.schema.ts`
- `AI-Harness-Clone/apps/api/src/agent/agent.service.ts` — **đọc `streamAgent` (dòng ~130–146) trước khi viết spike**; đó là chỗ tool event bị rơi
- `AI-Harness-Clone/config/litellm/config.yaml`, `docker-compose.yml`
- `StockFlow/docker-compose.yml`, `component/redis/redis.go`, `component/ratelimit/limiter.go`, `middleware/ratelimit.go`

## Tests First (TDD — một phần)

1. `platform/testcontainers.spec.ts` — khởi container, apply migration, assert schema `commerce` + `ai` và extension `vector`, `citext` tồn tại.
2. `platform/migrate.spec.ts` — chạy runner 2 lần ⇒ lần 2 không apply lại, `schema_migrations` không sinh row trùng.
3. `platform/error-envelope.spec.ts` — DTO sai ⇒ 400, đúng shape, có `x-request-id`.
4. `platform/health.spec.ts` — `/health` ok khi DB+Redis sống; 503 khi DB chết; 503 khi Redis chết.
5. **`platform/transaction-settings.spec.ts`** — trong một `withTransaction`, `SHOW transaction_isolation` = `read committed`, `SHOW lock_timeout` = `5s`, `SHOW statement_timeout` = `15s`.
6. **`platform/ratelimit.spec.ts`** — limiter theo key tuỳ biến: vượt ngưỡng trên key A ⇒ chặn A, **không** chặn key B.
7. **`platform/vitest-isolation.spec.ts`** — hai file test cùng ghi một bảng, chạy suite ⇒ không file nào thấy dữ liệu của file kia (chứng minh cấu hình isolation thật sự có hiệu lực).

## Implementation Steps

1. **Spike Bedrock trước tiên — và spike đủ sâu.** `docker compose up litellm`, chạy `scripts/spike-bedrock.ts`, xác minh **ba** thứ:
   - a) chat model trả lời được;
   - b) embedding trả **đúng 1024 chiều** — ghi số đo này vào ADR 0003 và Phase 07 migration phải khớp;
   - c) **một tool call thật phát event quan sát được.** Đăng ký một tool giả (`add(a,b)`), prompt buộc gọi nó, in **toàn bộ** event thô của `agent.stream()` chứ không lọc `textDelta`. Ghi lại hình dạng event.

   Kết quả (c) quyết định Phase 07: có event ⇒ map sang `RunEvent`; không có ⇒ `OpenAiToolLoopRuntime` (2–3 ngày, đã tính trong 6 ngày của Phase 07). **Nửa ngày ở đây gỡ ~7 ngày rủi ro ở tuần 6–7.** Nếu (a) hoặc (b) fail, dừng và xử lý trước khi làm tiếp.
2. pnpm workspace + tsconfig base + eslint (3 rule ở §Architecture) + prettier + quyết định tooling ở §Tooling. Viết ADR 0005 ngay.
3. `docker-compose.yml`: 5 service, healthcheck đủ, `depends_on` theo condition.
4. `db/migrations/001_schemas.sql` + `scripts/migrate.ts`.
5. Viết 7 test ở §Tests First (đỏ).
6. NestJS bootstrap: config (zod fail-fast), database (pool + `UnitOfWork` + session settings), **redis**, **ratelimit**, error filter, request-id, logging, zod pipe, health.
7. `vitest.config.ts` + `apps/api/test/setup.ts`. Test #7 xanh.
8. Scaffold `apps/web` (Vite + React + TS + Tailwind + shadcn init).
9. Scaffold `packages/contracts` + `packages/ai-harness`, wire theo quyết định ở bước 2.
10. `docs/code-standards.md`: ranh giới `platform/`↔`modules/`, rule transaction tường minh, rule tiền (`numeric`/minor-units, cấm float, **một currency**), rule "không text-to-SQL", rule "ledger append-only".
11. ADR 0001–0006.

## Success Criteria

- [ ] Spike chứng minh cả 3: chat trả lời, embedding **1024 chiều** (ghi vào ADR 0003), **tool call phát event quan sát được hay không** — kết luận ghi thành một dòng dứt khoát trong ADR. — **chờ AWS credential** (ADR 0003)
- [ ] Chiều embedding đo được **khớp** với `vector(N)` mà Phase 07 sẽ khai trong migration 009. — **chờ AWS credential** (ADR 0003)
- [x] `docker compose up` trên máy sạch ⇒ mọi service healthy, `GET /health` ok.
- [x] `pnpm migrate` 2 lần ⇒ idempotent.
- [x] 7 test ở §Tests First xanh.
- [x] `SHOW transaction_isolation` trong tx = `read committed`; `lock_timeout` và `statement_timeout` đúng.
- [x] Limiter chặn đúng theo key, không chặn key khác.
- [x] Hai file test không phá fixture của nhau.
- [x] ESLint báo lỗi khi cố import `pg` từ `modules/copilot/`, và khi cố import `modules/` từ `platform/`.
- [x] `docs/code-standards.md` + ADR 0001–0006 tồn tại.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| **Bedrock không truy cập được / model chưa bật** | Spike là bước 1 của phase 1. Fail ⇒ đổi region, hoặc trỏ LiteLLM sang provider khác để 01–05 không bị chặn (chỉ 07–09, 11 bị chặn — 18/39 ngày) |
| **Strands không phát tool event** | Chính là mục (c) của spike. Biết ở ngày 1 thay vì tuần 6. Fallback đã có giờ trong Phase 07 |
| Testcontainers chậm/flaky trên Windows | `fileParallelism: false`; pin image tag; một container cho cả suite; `hookTimeout` rộng cho lần pull đầu |
| Migration runner tối giản thiếu tính năng | Cố ý: chỉ forward. Ghi vào ADR cùng ràng buộc thứ tự phase |
| Over-engineering `platform/` | Chỉ build cái đang cần. Nhưng **không** cắt redis/ratelimit — Phase 01 (login throttle) và Phase 08 (ngân sách Bedrock) đều phụ thuộc, và plan đầu quên chúng |
| Phase phình từ 2–3 lên 4–5 ngày | Đây là công việc đã luôn tồn tại, chỉ bị giấu trong các phase sau. Trả ở đây rẻ hơn |
