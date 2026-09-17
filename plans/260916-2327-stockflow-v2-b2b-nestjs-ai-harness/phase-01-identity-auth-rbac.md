---
phase: 1
title: "Identity, Auth, RBAC & OrgScope"
status: completed
priority: P1
dependencies: [0]
---

# Phase 01: Identity, Auth, RBAC & OrgScope

> **Sửa sau red-team (finding #2, #8 + nhóm SSE/CSRF, login throttle).** Thay đổi lớn nhất: `OrgScope` thay cho `orgId` trần. Plan đầu cho ops user thuộc org `internal` rồi khoá mọi dữ liệu theo `buyer_org_id` — nên scope theo `actor.orgId` **trả rỗng cho mọi ops user**, tức acceptance criteria #4 như viết ban đầu *cấm ops console tồn tại*. 3→4 ngày.

## Thực tế đã build (2026-09-17)

Phần thiết kế bên dưới giữ nguyên để thấy đường đi. Những chỗ build khác đi, và vì sao (chi tiết: ADR 0007, 0009):

| Thiết kế | Đã build | Lý do |
|---|---|---|
| `OrgScope` hai biến thể | Thêm biến thể `all` (`identityScopeOf`) | Quản trị danh tính phải thấy cả org internal |
| `assertOrgInScope(scope, orgId)` | `assertOrgInScope(scope, { id, type })` | `all-buyers` phải loại org internal ⇒ cần biết loại org |
| CHECK gọi hàm `role_matches_org_type` | **Foreign key ghép** `(org_id, org_type)` + CHECK thuần | Hàm trong CHECK hỏng khi dump/restore và không thấy org đổi loại |
| Cột `failed_login_count` / `locked_until` | Bộ đếm **Redis** theo account + IP, **tăng trước khi kiểm mật khẩu** | Cột DB lộ email nào có thật; kiểm-trước-đếm-sau bị vượt bằng request song song (review H2) |
| Cookie `Path=/auth/refresh` | `Path=/auth` | Logout cũng cần cookie |
| `users.status` | `users.is_active` | Giữ tên cột của StockFlow |
| Guard ở `platform/auth/` | `modules/identity/http/`; `@Public` ở `platform/http/` | Guard cần kiểu `Actor` ⇒ đặt ở platform vi phạm lint |
| Kiểm role chỉ ở `@Roles` | Thêm `assertRole` **trong use case** | Review M2: job/tool của copilot không đi qua HTTP |
| Phiên không giới hạn nếu refresh liên tục | Tuổi thọ tuyệt đối **30 ngày** (`session_expires_at`) | Review M5 |
| Thu hồi họ token | Họ đã thu hồi thì **chết vĩnh viễn**, kể cả token sinh sau lúc thu hồi | Test song song phát hiện token của request thắng sống sót |
| Hai tab refresh cùng lúc | Giữ nguyên phía server; **Phase 09 tuần tự hoá bằng Web Locks** | Cửa sổ ân hạn phía server sẽ che token bị đánh cắp |
| — | Admin chỉ sửa **mật khẩu / kích hoạt / tên** khi thấy **mọi** org của user | Chặn chiếm tài khoản dùng chung xuyên tenant |

Kiểm thử: 178 test xanh (bao gồm 3 file `test/verification/` đã siết lại sau khi agent test viết chúng quá lỏng).

## Overview

Chương 4 — **Multi-tenant boundary & RBAC**. Thêm khái niệm tổ chức mua hàng mà repo Go không có, auth thật, và **mô hình phạm vi đọc** — thứ mà cả Phase 04 lẫn Phase 08 đều đứng lên.

## Requirements

**Functional**
- `organizations` với `type` = `buyer` | `internal`.
- User thuộc tổ chức qua `org_members`, role: `buyer` | `buyer_admin` | `ops` | `ops_admin`.
- **Ràng buộc: `ops`/`ops_admin` chỉ tồn tại trong org `internal`; `buyer`/`buyer_admin` chỉ trong org `buyer`.** Ràng buộc ở DB, không chỉ ở code.
- Đăng nhập email/password ⇒ access token (ngắn) + refresh token (xoay vòng).
- **`OrgScope`** — primitive quyết định actor đọc được dữ liệu của org nào.
- Guard: `@Public()`, `@Roles(...)`, `@CurrentActor()`, `@CurrentScope()`.
- Login throttle theo **account + IP**, backoff.
- Seed: 1 internal org + 2 buyer org + user cho từng role, **có cổng chặn**.

**Non-functional**
- argon2id (`@node-rs/argon2`, prebuilt — không node-gyp trên Windows).
- Refresh token lưu **hash**, xoay vòng, tái sử dụng ⇒ thu hồi cả family.
- **Refresh token transport và CSRF quyết định ở phase này**, không để Phase 09 tự quyết.
- Service nhận `OrgScope`, **không** nhận org id rời. Quên = lỗi compile.

## Architecture

```
modules/identity/
├── domain/          organization.ts · org-member.ts · user.ts · role.ts
│                    actor.ts · org-scope.ts  ← primitive trung tâm
│                    errors.ts · password.ts (VO)
├── application/     ports/{organization.repository.ts,user.repository.ts,
│                           refresh-token.repository.ts,password-hasher.ts}
│                    use-cases/{login,refresh,logout,create-user,
│                               create-organization,list-users,...}.ts
├── infrastructure/  sql-{organization,user,refresh-token}.repository.ts
│                    argon2-password-hasher.ts
└── http/            auth.controller.ts · organization.controller.ts · user.controller.ts
```

### `OrgScope` — sửa finding #2 (D1)

```ts
// modules/identity/domain/actor.ts
export interface Actor {
  userId: string
  orgId: string
  orgType: 'buyer' | 'internal'
  roles: Role[]
}

// modules/identity/domain/org-scope.ts
export type OrgScope =
  | { kind: 'single'; orgId: string }   // buyer: chỉ org của mình
  | { kind: 'all-buyers' }              // internal + ops: mọi buyer org

export function orgScopeOf(actor: Actor): OrgScope {
  if (actor.orgType === 'internal' && hasOpsRole(actor)) return { kind: 'all-buyers' }
  return { kind: 'single', orgId: actor.orgId }
}

/** Dùng khi caller chỉ định một org cụ thể (vd tool get_contract_price). */
export function assertOrgInScope(scope: OrgScope, orgId: string): void
```

Quy tắc, ghi vào `code-standards.md`:
- **Mọi application service đọc dữ liệu thuộc tổ chức đều nhận `scope: OrgScope` làm tham số.** Không nhận `orgId: string` trần.
- Repository dịch scope sang `WHERE`: `single` ⇒ `buyer_org_id = $1`; `all-buyers` ⇒ không lọc buyer org (nhưng **vẫn** join `organizations.type='buyer'`).
- Ghi dữ liệu thay mặt một org (tạo đơn) dùng `actor.orgId` và yêu cầu `orgType='buyer'` — ops **không** đặt đơn hộ ở v1.
- Caller chỉ định org cụ thể phải gọi `assertOrgInScope` trước. **Không bao giờ** tin org id đến từ input của người dùng hay của LLM.

Vì sao là kiểu union chứ không phải mảng org id: `all-buyers` diễn đạt được "mọi buyer, kể cả org tạo ra ngày mai" mà không phải truy vấn danh sách, và nó khiến việc mở rộng sau này (`{kind:'some', orgIds}` cho sales phụ trách vài khách) là thêm một nhánh, không phải viết lại.

### Refresh token transport + CSRF

Plan đầu để Phase 09 tự quyết "httpOnly cookie", mà toàn bộ 13 file không có một chữ `CSRF` hay `SameSite` nào. Với refresh xoay vòng + phát hiện tái sử dụng, một request CSRF **không cần đọc response** vẫn đủ để thu hồi cả family và **đăng xuất nạn nhân theo vòng lặp**.

Chốt ở đây:
- Refresh token: cookie `HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh`.
- Kiểm `Origin`/`Referer` ở endpoint refresh; sai origin ⇒ 403 **và không tính là tái sử dụng** (không thu hồi family).
- Access token: chỉ trong memory ở client, gửi qua header `Authorization`.
- **Token không bao giờ xuất hiện trong URL** — Phase 08/09 dùng `fetch` + `ReadableStream` cho SSE (có header), không dùng `EventSource`.

### Schema (migration `002_identity.sql`, schema `commerce`)

```sql
organizations(
  id uuid pk, code text unique not null, name text not null,
  type text not null check (type in ('buyer','internal')),
  tax_code text, status text not null default 'active',
  credit_limit numeric(18,2),            -- chừa chỗ v1.1, chưa dùng
  created_at, updated_at)

users(
  id uuid pk, email citext unique not null, password_hash text not null,
  full_name text not null, status text not null default 'active',
  failed_login_count int not null default 0, locked_until timestamptz,
  created_at, updated_at)

org_members(
  org_id uuid references organizations(id),
  user_id uuid references users(id),
  role text not null check (role in ('buyer','buyer_admin','ops','ops_admin')),
  created_at,
  primary key (org_id, user_id))

-- finding #8: role phải khớp loại org. Ràng buộc ở DB, không chỉ ở code.
create or replace function commerce.role_matches_org_type(p_org_id uuid, p_role text)
returns boolean language sql stable as $$
  select (o.type = 'internal' and p_role in ('ops','ops_admin'))
      or (o.type = 'buyer'    and p_role in ('buyer','buyer_admin'))
  from commerce.organizations o where o.id = p_org_id $$;

alter table org_members
  add constraint chk_role_matches_org_type
  check (commerce.role_matches_org_type(org_id, role));

refresh_tokens(
  id uuid pk, user_id uuid references users(id), family_id uuid not null,
  token_hash text not null, expires_at timestamptz not null,
  used_at, revoked_at timestamptz, created_at)
```

Không có ràng buộc đó thì một `buyer_admin` gán role `ops` cho người trong org mình, người đó qua `@Roles('ops','ops_admin')`, vào copilot, và chạm được đường ghi của Phase 08.

**`org_members` là bảng riêng** thay vì `users.org_id`: giữ, nhưng phải đóng lỗ hổng mà red-team chỉ ra — `Actor.orgId` là một string và login không có tham số org, nên user có 2 membership là **hành vi không xác định**. Quyết ở bước 7.

**Postgres RLS:** hoãn (vướng pooling với `SET LOCAL`); `OrgScope` ở tầng repository đủ cho v1. ADR ghi lý do.

## Related Code Files

**Create**
- `db/migrations/002_identity.sql`
- `apps/api/src/modules/identity/**`
- `apps/api/src/platform/auth/{jwt.guard.ts,roles.guard.ts,decorators.ts,actor.decorator.ts,scope.decorator.ts}`
- `packages/contracts/src/identity.ts`
- `scripts/seed.ts`
- `docs/adr/0007-org-scope-not-bare-org-id.md`
- `docs/adr/0008-defer-postgres-rls.md`
- `docs/adr/0009-refresh-token-transport-and-csrf.md`

**Modify**
- `apps/api/src/app.module.ts` — `IdentityModule`, guard global (mặc định chặn)
- `apps/api/src/platform/ratelimit/` — dùng cho login throttle (đã build ở Phase 00)
- `.env.example` — `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`, `SEED_ALLOW`
- `docs/code-standards.md` — rule `OrgScope`

**Reference (read-only)**
- `StockFlow/module/user/{model/user.go,biz/*.go,storage/sql_user.go,transport/gin/*.go}` — giữ `Filter.Normalize()` (trim + lowercase email)

## Tests First (TDD — nghiêm)

1. `identity/password.spec.ts` — argon2id: verify đúng/sai; hash hai lần khác nhau (salt).
2. `identity/login.spec.ts` — credential đúng ⇒ cặp token; sai ⇒ `INVALID_CREDENTIALS`; user inactive ⇒ từ chối; **message giống hệt nhau cho email sai và password sai**.
3. `identity/refresh-rotation.spec.ts` — refresh hợp lệ ⇒ cặp mới, cũ vô hiệu; **dùng lại ⇒ thu hồi cả family**.
4. **`identity/refresh-csrf.spec.ts`** — refresh với `Origin` lạ ⇒ 403, **và family KHÔNG bị thu hồi** (nếu không, CSRF thành vector đăng xuất hàng loạt).
5. `identity/roles-guard.spec.ts` — `@Roles('ops_admin')`: `ops` ⇒ 403; `ops_admin` ⇒ 200; không token ⇒ 401.
6. **`identity/org-scope.spec.ts`** — `orgScopeOf`: buyer ⇒ `single`; internal+ops ⇒ `all-buyers`; internal **không** có role ops ⇒ `single` (không leo thang bằng cách chỉ ở đúng org).
7. **`identity/assert-org-in-scope.spec.ts`** — `single` scope + org id khác ⇒ ném lỗi; `all-buyers` + org **buyer** ⇒ ok; `all-buyers` + org **internal** ⇒ ném lỗi.
8. **`identity/role-org-type-constraint.spec.ts`** — INSERT `org_members(role='ops')` vào org `buyer` ⇒ **DB từ chối**.
9. `identity/buyer-isolation.spec.ts` — buyer org A gọi list ⇒ chỉ thấy của A; get-by-id resource của B ⇒ **404, không phải 403**.
10. **`identity/ops-can-read-all-buyers.spec.ts`** — ops đọc được resource của cả A lẫn B. *(Test này là thứ plan đầu thiếu — nó chứng minh ops console khả thi mà không cần bypass.)*
11. `identity/login-throttle.spec.ts` — vượt `LOGIN_MAX_ATTEMPTS` ⇒ 429 + khoá tạm; khoá theo **account**, không chỉ theo IP.
12. `identity/seed-gate.spec.ts` — `SEED_ALLOW` chưa bật ⇒ seed từ chối chạy.

## Implementation Steps

1. Migration `002_identity.sql` gồm hàm + `CHECK` role↔org type.
2. Viết 12 test ở §Tests First — đỏ.
3. `domain/`: `Organization`, `User`, `OrgMember`, `Role`, `Actor`, **`OrgScope` + `orgScopeOf` + `assertOrgInScope`** (thuần, không I/O), `Password` VO, `errors.ts`. Test #6, #7 xanh không cần DB.
4. `application/ports/`: interface hẹp theo use case. **Method đọc dữ liệu thuộc tổ chức nhận `scope: OrgScope`.**
5. `infrastructure/`: SQL repository; hàm dịch `OrgScope` → mệnh đề `WHERE` nằm **một chỗ duy nhất**, dùng lại ở mọi repository.
6. `Argon2PasswordHasher`.
7. Use cases: `login` (+ throttle), `refresh` (+ kiểm origin), `logout`, `createOrganization`, `createUser`, `listUsers`, `getUser`, `updateUser`. **Quyết định multi-membership ở đây**: login nhận `orgCode` tuỳ chọn; user có đúng 1 membership thì suy ra; có ≥2 mà không truyền ⇒ 400 kèm danh sách org. Ghi vào ADR 0007.
8. `platform/auth/`: `JwtGuard` global (trừ `@Public()`), `RolesGuard`, `@CurrentActor()`, `@CurrentScope()`.
9. `http/`: controller + DTO zod, export sang `packages/contracts`. Refresh cookie theo §Architecture.
10. `scripts/seed.ts`: gate bằng `SEED_ALLOW=true` **và** từ chối khi `NODE_ENV=production`. 1 internal org + 2 buyer org (bảng giá sẽ khác nhau rõ rệt ở Phase 02) + 4 user.
11. Test xanh. ADR 0007, 0008, 0009.

## Success Criteria

- [x] 12 test ở §Tests First xanh.
- [x] **Ops đọc được dữ liệu của mọi buyer org qua `OrgScope`** — không có nhánh `if (orgType === 'internal') skip filter` ở bất kỳ repository nào (grep xác nhận).
- [x] Buyer org A không truy cập được resource org B; get-by-id chéo ⇒ **404**.
- [x] DB từ chối `ops` trong org buyer.
- [x] Refresh CSRF ⇒ 403 và **không** thu hồi family.
- [x] Dùng lại refresh đã dùng ⇒ thu hồi cả family.
- [x] Sai email và sai password trả message giống hệt nhau.
- [x] Login brute-force bị chặn theo account, không chỉ IP.
- [x] Endpoint chưa `@Public()` mà gọi không token ⇒ 401.
- [x] `pnpm seed` từ chối chạy khi chưa bật `SEED_ALLOW`.
- [x] Không method repository nào đọc dữ liệu tổ chức mà thiếu tham số `scope`.
- [x] ADR 0007, 0008, 0009 tồn tại; 0007 nêu rõ quyết định multi-membership.

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| **`OrgScope` bị bypass bằng một nhánh `if internal`** dưới áp lực tiến độ — chính là kịch bản red-team dự đoán | `scope` là tham số bắt buộc trong signature port; hàm dịch scope→WHERE nằm một chỗ; test #10 chứng minh ops **không cần** bypass; success criteria có bước grep |
| Quên truyền `scope` ở một query | Lỗi compile |
| Refresh rotation + CSRF tương tác thành vector đăng xuất hàng loạt | Test #4 phủ đúng đường này trước khi viết code |
| argon2 native build lỗi trên Windows | `@node-rs/argon2` (prebuilt) |
| `Actor` phình thành God object | Giữ 4 field; cần thêm thì tra qua service |
| Multi-membership để mơ hồ | Bước 7 quyết dứt điểm và ghi ADR — không để `Actor.orgId` là hành vi không xác định |
| Seed user mật khẩu biết trước lọt ra ngoài | Gate `SEED_ALLOW` + chặn `NODE_ENV=production`; test #12 |
