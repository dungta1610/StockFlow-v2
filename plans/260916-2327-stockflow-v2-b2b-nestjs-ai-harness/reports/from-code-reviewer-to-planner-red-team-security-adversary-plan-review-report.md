# Red-team plan review — security adversary lens

**Reviewer:** code-reviewer (hostile posture, SECURITY ADVERSARY lens + FACT CHECKER role)
**Target:** `plans/260916-2327-stockflow-v2-b2b-nestjs-ai-harness/` (13 files, 2264 lines)
**Reference repos (read-only, verified):** `StockFlow/StockFlow` (Go/Gin), `AI Harness Clone/AI-Harness-Clone` (NestJS)
**Date:** 2026-09-17

---

## Verdict

The plan's factual claims about both reference repos are accurate — I could not break the fact base (23 claims checked, 20 VERIFIED, 3 partial/failed, all listed below). The schema reconstruction from Go SQL strings is correct column-for-column.

The security model is where it falls apart. The plan builds an elaborate tenant-isolation story around one mechanism (`Actor.orgId` threaded through application services) and then ships three surfaces that never touch that mechanism: **copilot chat sessions**, **the payment callback**, and **the proposal approve endpoint**. It also never resolves what `orgId` even *means* for the `internal` org — which is the org every copilot user belongs to. Acceptance criteria #4 and #5 ("no cross-org leak through any endpoint, including copilot"; "copilot cannot exceed permissions") are not achievable as specified.

---

## Finding 1: Copilot chat sessions have no owner — IDOR bypasses every tool-level control

- **Severity:** Critical
- **Location:** Phase 08 §Requirements/§Implementation Steps; Phase 07 §Schema

**Flaw.** Phase 08 exposes `POST /copilot/sessions/:id/messages`, `GET /copilot/sessions/:id` and `GET /copilot/sessions` guarded by *role only* (`@Roles('ops','ops_admin')`, phase-08:186). Phase 07 ports `chat_sessions`/`chat_messages` verbatim from the harness, and the upstream table has **no owner, no user_id, no namespace, no org_id** — only `id`, `agent_name`, timestamps. No phase adds one. No test in Phase 08's 15-test list covers session ownership; §Success Criteria does not mention it.

The entire Phase 08 defense ("tool factory receives `Actor`, tools call org-scoped services") protects the *write* path into the conversation. It does nothing for the *read* path out of it: the transcript already contains org A's inventory numbers, order codes, contract prices and the agent's rationale.

**Failure scenario.**
1. Ops user U_a (org A) chats with the copilot: "which orders for ACME are about to expire?" The reply, containing order codes, quantities and contract prices, is persisted to `ai.chat_messages` under session S.
2. Ops user U_b (org B, or any `ops` role holder — see Finding 4) obtains S. UUIDs leak through the `stock_adjustment_proposals.session_id` column exposed on the proposal list endpoint (`GET /ops/stock-adjustment-proposals`, phase-08:24, column at phase-08:112), through `audit_log.payload`, or through a shared screenshot.
3. `GET /copilot/sessions/S` → 200. Full transcript of org A. Zero tools invoked, so zero `Actor` checks fired.
4. Worse: `POST /copilot/sessions/S/messages` with "summarise everything above" runs the agent with U_b's `Actor` over org A's transcript. The LLM happily reads org A's data out of history and answers. Tools were never the leak path.

**Evidence.**
- `AI-Harness-Clone/db/init/003_sessions.sql:2-7` — `chat_sessions(id, agent_name, created_at, updated_at)`, no owner column.
- `phase-07-ai-harness-package.md:130` — `003_sessions → ai.chat_sessions, ai.chat_messages` — ported as-is, no added column.
- `phase-08-ops-copilot.md:20-22` — the three session endpoints.
- `phase-08-ops-copilot.md:186` — only guard specified is `@Roles('ops','ops_admin')`.
- `phase-08-ops-copilot.md:149-174` — 15 tests; #2/#3 cover tool input and memory namespace, none covers session ownership.
- `grep -rni "session" plans/*.md` returns no occurrence tying a session to a user or org.

**Suggested fix.** Add `org_id uuid not null` + `owner_user_id uuid not null` to `ai.chat_sessions` in migration 009, and make `SessionService` require them on every read (mandatory parameter, same discipline as `MemoryStore.namespace`). Add a Phase 08 Group-A test: "actor of org B requests/continues org A's session ⇒ 404". This must be written before Phase 08 code, because it changes the harness's session interface (Phase 07), not just the copilot module.

---

## Finding 2: The authorization model for the `internal` org is undefined, and Phase 08 contradicts itself about it

- **Severity:** Critical
- **Location:** Phase 08 §Bảng tool vs §Tests First #2; Phase 04 §Luồng tạo đơn; Phase 01 §Architecture

**Flaw.** Every ops/copilot user lives in the `internal` org (`organizations.type in ('buyer','internal')`, phase-01:63; seed = 1 internal org + 2 buyer orgs, phase-01:128). All commerce data is keyed to *buyer* orgs: `orders.buyer_org_id references organizations(id)` (phase-04:118), list/get scoped by `buyer_org_id` (phase-04:99, 242), `PriceResolver.resolve(orgId, …)` (phase-02:64), `price_lists.org_id` (phase-02:95).

So "every service scopes by `actor.orgId`" produces, for an internal-org actor, **the empty set**. The plan never states the rule that lets ops see buyer data. And Phase 08 contradicts itself on the same page:

- phase-08:82 — `find_orders | OrderService.list | đọc | đơn theo filter (status, org, kho, khoảng ngày)` — an **org filter is part of the tool contract**.
- phase-08:152 (test #2) — "Tool phải lấy org từ `Actor`, **bỏ qua mọi orgId trong input**".
- phase-08:209 (risk row) — "schema zod của tool **không khai báo** field `orgId`".

These cannot all be true. And phase-08:15 states the copilot must answer *"giá hợp đồng của khách A cho SKU này là bao nhiêu?"* — a question that is only answerable by passing a buyer org id that is not `actor.orgId`.

**Failure scenario.** Implementation day, Phase 08 step 4. The developer wires `find_orders` to `actor.orgId`, runs it against seed data, gets zero rows, and "fixes" it the only way the plan leaves open: either the tool takes an `orgId` input after all (test #2 gets weakened — and now a prompt-injected LLM chooses the tenant), or `OrderService.list` gains an `if (actor.orgType === 'internal') skip org filter` branch. That branch is now the tenant boundary for **every caller** of `OrderService.list`, including the HTTP controller — and it is a one-line implicit decision made under schedule pressure, not a designed control. A buyer-org user who acquires an `ops` role (Finding 4) then reads all orders of all orgs.

**Evidence.** `phase-01-identity-auth-rbac.md:18,52,63,128`; `phase-02-catalog-warehouse-pricing.md:64,95`; `phase-04-ordering-atomic-reservation.md:67,99,118,242`; `phase-08-ops-copilot.md:15,82,85,152,209`. Upstream brainstorm has the same gap: `reports/from-brainstorm-…-report.md:243-244,331-360` states "tool nhận actor ⇒ agent không bao giờ có quyền cao hơn người đang chat" without ever defining the internal-org read scope.

**Suggested fix.** Decide this in Phase 01, not in Phase 08 code. Introduce an explicit, testable predicate — e.g. `ActorScope.readableOrgIds(actor): 'own' | OrgId[]` where `internal` + `ops` resolves to "all buyer orgs of this tenant" — and make it the single argument every service takes instead of a bare `orgId`. Then rewrite Phase 08 test #2 against the real threat: an internal-org actor without `ops` role, and an LLM-supplied org id for an org outside the actor's scope. Until this is settled, acceptance criteria #4 (plan.md:96) is untestable, because "user org A không đọc được order của org B" says nothing about the org that is supposed to read both.

---

## Finding 3: The payment callback is unauthenticated, unsigned, and its simulate switch is on in every environment that will ever exist

- **Severity:** Critical
- **Location:** Phase 06 §Requirements, §Architecture (PaymentGateway port), §Implementation Steps 5/8

**Flaw.** `POST /payments/callback` (phase-06:21) is a gateway webhook. Phase 01 makes the JWT guard global with `@Public()` as the opt-out (phase-01:126,137), so the callback is either (a) behind JWT — in which case a real gateway could never call it and the design is wrong from day one — or (b) `@Public()`, in which case the only control is `verifyCallback`. The plan never says which. And `verifyCallback` on the only adapter that exists is specified to **always return valid**: "Adapter mô phỏng trả về 'hợp lệ' nhưng vẫn phải đi qua đúng đường đó" (phase-06:53). There is no shared secret, no HMAC, no timestamp, no replay window, no nonce anywhere in Phase 06. The `__simulate: 'success'` trigger is gated on `NODE_ENV !== 'production'` (phase-06:125) — and this project explicitly never deploys (plan.md:124 "Deploy AWS + CI/CD — Out"), so `NODE_ENV` is never `production` in any environment the team runs, including the demo. The guard is a no-op by construction.

**Failure scenario.**
1. Attacker (or any authenticated buyer, or anyone on the network for a `docker compose` demo) enumerates or is issued a `payment_code` — buyers receive their own from `POST /payments/checkout`, and the format is a code, not a secret.
2. `POST /payments/callback {payment_code, status: 'succeeded', external_txn_id: <any>, __simulate: 'success'}`.
3. `HandleCallbackUseCase` verifies via the simulated gateway (always valid), claims on `UNIQUE(method, external_txn_id)`, calls `OrderService.markPaid` (phase-06:128-129). Order is now `paid` without money.
4. `paid` is terminal for the lifecycle: cancel is refused and the Phase 05 sweeper is explicitly filtered to skip paid orders (phase-04:62; phase-05:96,148). The held stock is now **permanently reserved** with no release path in v1 — there is no refund/void use case anywhere in the plan. One request per SKU × warehouse, repeated, is a permanent inventory denial-of-service against the invariant Phase 03–04 spent 6 days building.

Note test #7 (phase-06:114) only asserts an unknown `payment_code` returns 404 — it confirms the endpoint answers unauthenticated callers, it does not defend against them.

**Evidence.** `phase-06-payment-simulated.md:21,50-53,60,114,125,128,151`; `phase-01-identity-auth-rbac.md:126,137`; `phase-04-ordering-atomic-reservation.md:62`; `phase-05-outbox-relay-scheduler.md:96,148`; `plan.md:124`. Upstream Go repo has the same hole and is not a defence: `StockFlow/module/payment/transport/gin/callback_payment_handler.go:13-36` — binds JSON and calls biz, no auth; `StockFlow/module/payment/biz/callback_payment.go:22-49` — trims and validates, no signature.

**Suggested fix.** Make the simulated adapter carry a real secret: `PAYMENT_SIMULATED_WEBHOOK_SECRET`, HMAC over the raw body, timestamp + `±5min` window, and a `verifyCallback` that actually rejects. Gate `__simulate` on an explicit `PAYMENT_ALLOW_SIMULATE=true` env flag, not on `NODE_ENV`. Add Phase 06 tests: unsigned callback ⇒ 401; replayed signature outside the window ⇒ 401; body tampered after signing ⇒ 401. Without these, phase-06:139 ("verifyCallback nằm trên mọi đường callback") certifies that a function that always returns true was called.

---

## Finding 4: The one write path the agent has — proposal approval — has no specified authorization, and `ops` roles are not bound to the internal org

- **Severity:** Critical
- **Location:** Phase 08 §Requirements, §Implementation Steps 8/10, §Tests C; Phase 01 §Schema

**Flaw.** Three gaps compose:

1. `POST /ops/stock-adjustment-proposals/:id/{approve,reject}` (phase-08:24) has **no `@Roles`** specified. Step 9 attaches `@Roles('ops','ops_admin')` to the *copilot* controller; step 10 says only "`http/proposal.controller.ts` — list/approve/reject" (phase-08:186-187). Tests #9–#12 cover behaviour and idempotency; none covers "who may approve". §Success Criteria (phase-08:192-203) never mentions it.
2. No separation of duties: nothing prevents the same user who made the agent produce the proposal from approving it. "Human-in-the-loop" is asserted as the control that makes an LLM write path safe (phase-08:89, ADR 0019), but a loop where the proposer is the approver is not a control.
3. `stock_adjustment_proposals.org_id` (phase-08:106) is decorative. `inventory` has **no org dimension at all** — `inventory(product_id, warehouse_id, …)`, `warehouses(code, name, …)` are global (phase-03:49-59; phase-02:87-89). So an approved proposal adjusts global stock regardless of which org it was raised under. There is no check that `proposal.org_id` matches the approver's org, and no such check would mean anything anyway.
4. `org_members.role check (role in ('buyer','buyer_admin','ops','ops_admin'))` (phase-01:75) has **no constraint tying role to `organizations.type`**. Nothing in the schema or the plan forbids an `ops` member inside a *buyer* org.

**Failure scenario.** A `buyer_admin` of buyer org B adds a member of their own org with role `ops` (the plan specifies `createUser`/user management use cases at phase-01:125 but never says who may assign which role in which org). That user now passes `@Roles('ops','ops_admin')`, reaches the copilot, calls `propose_stock_adjustment`, then hits the unguarded approve endpoint, and `ApproveProposalUseCase` calls `AdjustStockUseCase` (phase-08:185) writing global inventory — with a ledger row that dutifully records the whole thing. Acceptance criterion #5 ("tool ghi duy nhất chỉ tạo đề xuất chờ duyệt", plan.md:97) is satisfied literally and defeated completely.

**Evidence.** `phase-08-ops-copilot.md:24,89,104-121,165-168,185-187,192-203`; `phase-01-identity-auth-rbac.md:19,75,125`; `phase-03-inventory-core-ledger.md:49-59`; `phase-02-catalog-warehouse-pricing.md:87-89`; `plan.md:97`.

**Suggested fix.** (a) Add a DB constraint or a domain invariant that `ops`/`ops_admin` may only exist in an `internal` org, plus a Phase 01 test. (b) Specify `@Roles('ops_admin')` on approve/reject, with a test that `ops` gets 403 and that `proposed_by_user_id <> decided_by_user_id` is enforced. (c) Either give inventory an owning org or delete `stock_adjustment_proposals.org_id` and stop implying a boundary that does not exist.

---

## Finding 5: Idempotency claim semantics are unspecified for the two cases that actually occur

- **Severity:** High
- **Location:** Phase 04 §Luồng tạo đơn steps 2/8/9, §Schema, test #13

**Flaw.** Step 2 claims the key with `INSERT … ON CONFLICT DO NOTHING` and branches on **`request_hash` only**; step 8 writes `response_snapshot` and `status='completed'`; the whole sequence sits under the heading "một transaction duy nhất" (phase-04:64). The table carries `status text not null default 'in_progress'` (phase-04:167) — but **no step ever reads it**. Two consequences the plan does not address:

1. **Duplicate while the first is in flight.** If the claim is inside the order transaction, the second request's `ON CONFLICT DO NOTHING` blocks on the uncommitted row and behaviour depends on lock waits — with a 50-item order under contention (Phase 04 test #1 runs 50 concurrent creates) this is a request-path stall, not a fast 409. If the claim is in its own transaction, the second request finds `status='in_progress'` with `response_snapshot = NULL`, matches the `request_hash` branch, and returns a null snapshot — a 200 with no order. Which of the two happens is determined by an implementation detail the plan leaves open, and the difference is a correctness bug either way.
2. **Rollback erases the claim.** Steps 2–9 are one transaction, so an `INSUFFICIENT_STOCK` failure (step 5) rolls the key row away. The key is then reusable with a *different* body and the `IDEMPOTENCY_KEY_REUSED` 409 (phase-04:72) never fires for the most common failure path — precisely the path Phase 10 tells the buyer UI to retry on (phase-10:26,103,126).

Test #13 asserts only "đúng một đơn được tạo" (phase-04:223); it does not assert what the *second* caller receives, so it will pass against a null-body response.

**Failure scenario.** Buyer double-clicks "Đặt hàng" on a slow link (the exact scenario phase-10:32 designs for). Request 2 arrives while request 1 is still reserving. Request 2 returns `{}`/`null` with 200. The web client parses it through the contracts zod schema (phase-09:76) and throws a parse error, or renders an order page with no order. The user clicks again, now with a fresh key, and gets a second real order — the duplicate the whole mechanism existed to prevent.

**Evidence.** `phase-04-ordering-atomic-reservation.md:64-87,164-169,223,238,266`; `phase-10-buyer-portal.md:26,32,103,126`; `phase-09-web-ops-console.md:76`.

**Suggested fix.** Specify the claim as its own committed transaction *before* the order transaction, define the three states explicitly (`in_progress` ⇒ 409 `IDEMPOTENCY_IN_PROGRESS` with `Retry-After`; `completed` + same hash ⇒ replay snapshot; any state + different hash ⇒ 409 `IDEMPOTENCY_KEY_REUSED`), and decide deliberately whether a failed attempt releases the key (`status='failed'`) or burns it. Extend test #13 to assert the second caller's status code and body, and add a test for "failed attempt, then retry with a different body".

---

## Finding 6: `audit_log` is a cross-tenant data lake with no access control specified

- **Severity:** High
- **Location:** Phase 05 §Schema + `modules/audit/`; Phase 09 §State machine trực quan

**Flaw.** `audit_log` receives the full `payload jsonb` of **every** domain event from every org — orders, prices, inventory (phase-05:24,108-117). The module is scaffolded with an `http/` directory (phase-05:46) and the migration adds `create index on audit_log (org_id, occurred_at desc)` (phase-05:116), implying a read API. Phase 05 never states a role, never states org scoping, and none of its 9 tests touches the audit read path. Phase 09 then consumes it from the UI: "timeline sự kiện lấy từ `audit_log`" on order detail (phase-09:91).

Two additional defects in the same schema: `org_id uuid` is **nullable** (phase-05:113) — so any event whose payload lacks an org (inventory adjustments, which are org-less per Finding 4) lands with `org_id = NULL` and is invisible to an org-scoped filter, or visible to everyone depending on how the `WHERE` is written. And `payload` is stored verbatim from the outbox, meaning `order.created` payloads carry `unit_price` + `price_list_item_id` — org A's negotiated contract pricing, the single most commercially sensitive field in a B2B system.

**Failure scenario.** Phase 09 needs an order timeline. The implementer adds `GET /audit?aggregate_id=<orderId>` (the natural fit for the `(aggregate_type, aggregate_id)` index at phase-05:115) because no phase told them otherwise. A buyer in org B passes org A's order id — obtainable from the `order_code` format `ORD-YYYYMMDD-<seq>` which Phase 04 deliberately makes **sequential and enumerable** (phase-04:177) — and reads org A's full order payload including contract unit prices. Acceptance criterion #4 falls to an endpoint that no phase ever assigned an owner.

**Evidence.** `phase-05-outbox-relay-scheduler.md:24,45-46,108-117,140-150`; `phase-04-ordering-atomic-reservation.md:84,177`; `phase-09-web-ops-console.md:91`.

**Suggested fix.** Make `audit_log.org_id NOT NULL` (derive from the aggregate; refuse to project events that cannot be attributed), specify the read endpoint as `@Roles('ops_admin')` + mandatory org filter, and add a Phase 05 test "buyer org B cannot read audit rows of org A". Consider projecting a redacted payload rather than the raw outbox payload — the audit consumer is the one place where every tenant's data is deliberately co-located, so it deserves the strictest rule in the system, not the only one that was omitted.

---

## Finding 7: SSE authentication and refresh-cookie CSRF are both unspecified — zero mentions across 2264 lines

- **Severity:** High
- **Location:** Phase 09 §Non-functional + `lib/sse.ts`; Phase 08 §Requirements (SSE); Phase 01 §Requirements

**Flaw.** Phase 09 decides unilaterally that the refresh token lives in an `httpOnly` cookie (phase-09:32) — a decision Phase 01 never made (phase-01:20,26 describe rotation and hashing, not transport). `grep -rni "CSRF\|SameSite" plans/*.md` returns **nothing**. A cookie-borne `POST /auth/refresh` with no `SameSite=Strict`, no double-submit token and no origin check is CSRF-able from any page the user visits; CORS (phase-09:104) does not stop it, since the attacker does not need to read the response — with rotation-with-reuse-detection (phase-01:26,112) a forged refresh silently **revokes the whole family and logs the victim out**, which is a trivially weaponised availability attack against ops staff.

Separately, Phase 08 streams the copilot over SSE and Phase 09 builds `lib/sse.ts` against it (phase-08:21,25; phase-09:44,82,118), while the access token is deliberately kept **in memory only** (phase-09:32). Browser `EventSource` cannot send an `Authorization` header. The plan never says how the stream authenticates. The default resolution is a token in the query string — which lands in access logs, the `logging.interceptor` built in Phase 00 (phase-00:90), and any proxy in between.

**Failure scenario A.** Ops user has the console open; a phishing/ad iframe issues `fetch('https://api/auth/refresh', {credentials:'include', method:'POST'})`. The server rotates, the browser's next real refresh presents the now-used token, reuse detection fires, family revoked, user is logged out mid-shift. Repeat on a loop = ops console unusable.
**Failure scenario B.** `GET /copilot/sessions/:id/stream?token=<JWT>` — the bearer token for an `ops_admin` is written to the request log on every message, then read by anyone with log access (or by the LLM itself if logs ever get summarised).

**Evidence.** `phase-09-web-ops-console.md:32,44,82,104,116-118`; `phase-08-ops-copilot.md:21,25,172`; `phase-01-identity-auth-rbac.md:20,26,101,112`; `phase-00-foundation-and-bedrock-spike.md:90`; absence verified by `grep -rni "csrf\|samesite" plans/260916-…/*.md` → 0 hits.

**Suggested fix.** Move the refresh-transport decision into Phase 01 where the rotation invariant lives: `SameSite=Strict; Secure; HttpOnly; Path=/auth/refresh` plus an origin check, and a Phase 01 test "cross-origin refresh ⇒ rejected and family NOT revoked" (a forged request must not be able to trigger reuse detection). For SSE, specify `fetch` + `ReadableStream` with an `Authorization` header (not `EventSource`), or a short-lived single-use stream ticket — and state explicitly that tokens never appear in URLs.

---

## Finding 8: "namespace is mandatory" is a signature convention, not an enforcement — and `supersede` upstream ignores namespace entirely

- **Severity:** High
- **Location:** Phase 07 §2 (`namespace` từ tuỳ chọn thành bắt buộc), §Tests First #1/#2; Phase 08 §Memory scoping

**Flaw.** Phase 07 asserts the tenant boundary is a compile-time guarantee: "Không method nào có namespace optional hay default… quên là lỗi compile" (phase-07:88-97), and Phase 11 books it as the enforcement point for the multi-tenant invariant (phase-11:53). Adding a parameter to a signature guarantees the *caller* passes something; it guarantees nothing about the `WHERE` clause. The upstream implementation proves the gap is real: `supersede(ids: number[])` has **no namespace at all** and updates `WHERE id = ANY($1::bigint[])` — any row, any tenant. Phase 07 adds a `namespace` parameter to the signature (phase-07:93) but never says the predicate must be added to the SQL, and its test #2 (phase-07:162) only exercises `search`. `neighbours`, `list` and `supersede` have no isolation test. `supersede` is the one method that *writes* across rows, and it is invoked by consolidation on LLM-derived ids (`AI-Harness-Clone/apps/api/src/memory/consolidation.service.ts:189`).

Secondary: Phase 07 types ids as `string[]` while the upstream key is `BIGSERIAL`/`number` (`db/init/002_memory.sql:4`, `memory-store.interface.ts:3`) — the contract was rewritten without checking, which is exactly the kind of drift that makes the "compile error" claim hollow.

Also note that `memoryScope(orgId) = "org:${orgId}"` (phase-08:94) gives **all ops users of the internal org one shared memory namespace**, so the "memory tenant isolation" test #3 (phase-08:153) tests a boundary that, per Finding 2, no copilot user ever crosses — it is a phantom test proving nothing about the real deployment.

**Failure scenario.** Consolidation for org A's session produces a candidate; adjudication returns ids from `neighbours`; a malformed or injected extraction (the memory content is LLM-generated from user-controlled order notes and product names) yields ids belonging to org B's namespace; `supersede` — with a namespace parameter that the SQL ignores — marks org B's memories superseded. Org B's copilot silently forgets operational facts. No test fails, and `superseded_at` makes it look intentional in the audit trail.

**Evidence.** `AI-Harness-Clone/apps/api/src/memory/pgvector-memory.store.ts:184-192` (supersede, no namespace); `:194-204` (list), `:206-222` (nearest); `AI-Harness-Clone/apps/api/src/memory/memory-store.interface.ts:3,51-80`; `AI-Harness-Clone/db/init/002_memory.sql:3-10`; `phase-07-ai-harness-package.md:88-97,161-162,193`; `phase-08-ops-copilot.md:94-99,153`; `phase-11-docs-diagrams-hardening.md:53`.

**Suggested fix.** State the rule as "every `MemoryStore` SQL statement includes `namespace = ANY($ns)`" and prove it with a contract test that runs *every* method cross-namespace (upsert/search/list/neighbours/supersede), not just search. Add a repo-scan assertion that no statement in `pgvector-memory.store.ts` lacks a namespace predicate — the same grep-gate discipline already applied to copilot SQL (phase-08:196).

---

## Finding 9: Rate limiting is attributed to a phase that does not build it, and no auth endpoint is rate limited at all

- **Severity:** Medium
- **Location:** Phase 08 §Reference; Phase 00 §Related Code Files; Phase 01 §Tests/Success Criteria

**Flaw.** Phase 08 lists `StockFlow/component/ratelimit/limiter.go`, `middleware/ratelimit.go` as "Redis limiter **đã port ở Phase 00**" (phase-08:145) and step 11 depends on it. Phase 00 ports no such thing: its Create list (phase-00:80-98) contains no rate-limit file, its Reference list mentions only `component/redis/redis.go` (phase-00:106), its platform tree (phase-00:37-43) has no limiter, and no `.env` var for it appears before Phase 08. Phase 08 therefore has an undeclared dependency on unbuilt work — and rate limiting is the *only* stated control on Bedrock spend (plan.md:141, phase-08:214).

Separately, across all 13 files, rate limiting is mentioned only for the copilot. `POST /auth/login` runs argon2id (deliberately expensive, phase-01:25) with no throttle, no lockout, no backoff — `grep -i "brute\|lockout"` → 0 hits, and Phase 11's hardening pass says only "rà rate limit áp đúng các endpoint tốn kém" (phase-11:118), which is a note, not a requirement. The Go limiter being ported keys on `c.ClientIP()` + path (`middleware/ratelimit.go:18-26`), which is a per-IP limiter — fine for cost control, useless against distributed credential stuffing, and the plan inherits that without noting it.

Finally, `scripts/seed.ts` creates a deterministic user per role (phase-01:128) and the plan requires `docker compose up` on a clean machine to produce a seeded, loginable system (plan.md:100; phase-09:155). No phase gates seeding on an environment check. Deterministic seed credentials plus "no deploy in v1" is acceptable *today*, but the plan also declares the architecture "12-factor, stateless" and deploy-ready from P00 (plan.md:124) — the first time someone runs this image anywhere reachable, four known-password accounts including `ops_admin` come with it.

**Evidence.** `phase-08-ops-copilot.md:139,145,188,214`; `phase-00-foundation-and-bedrock-spike.md:37-43,80-98,106`; `phase-01-identity-auth-rbac.md:25,106-115,128,131-140`; `phase-11-docs-diagrams-hardening.md:118`; `plan.md:100,124,141`; `StockFlow/middleware/ratelimit.go:12-36`.

**Suggested fix.** Move the Redis limiter into Phase 00's Create list explicitly (it is a `platform/` concern and Phase 01 needs it before Phase 08 does). Add to Phase 01: per-account + per-IP login throttle with exponential backoff, and a test. Gate `scripts/seed.ts` on an explicit `SEED_ALLOW=true` env var and have it refuse when `NODE_ENV=production` — a two-line guard that costs nothing and removes the failure mode entirely.

---

## Fact Check Results

23 claims sampled and checked against the two reference repos.

| # | Claim (plan location) | Result | Evidence |
|---|---|---|---|
| 1 | `CreateOrder` never touches inventory (phase-04:13) | **VERIFIED** | `StockFlow/module/order/storage/sql_order_tx.go:13-130` — INSERT orders + order_items only, then commit |
| 2 | `inventory_reservations` code exists but is never called (phase-04:13,199) | **VERIFIED** | `sql_inventory_reservation.go:13,50,98` define Create/Get/List; `grep -rn "Reserv" --include=*.go` over `biz/`, `transport/`, `main.go` → zero callers |
| 3 | Client supplies `unit_price` (plan.md:94; phase-04:212) | **VERIFIED** | `module/order/model/order_item.go:18-22` `OrderItemCreate.UnitPrice float64`; consumed at `sql_order_tx.go:33,39` — `lineTotal := reqItem.UnitPrice * qty`, never read from `products` |
| 4 | Money is `float64` in the Go repo (phase-11:67) | **VERIFIED** | `model/order.go:25`, `model/order_item.go:13-14`, `module/payment/model/payment.go:14,26` |
| 5 | Cancel/Expire only change status, no stock release (phase-04:111) | **VERIFIED** | `sql_order_tx.go:194-207` (cancel) and `:279-288` (expire) — single `UPDATE orders`, no inventory/reservation touch |
| 6 | `order_code` uses `RANDOM()` 6 digits with a UNIQUE column (phase-04:177) | **VERIFIED** | `sql_order_tx.go:302-313` — `LPAD((FLOOR(RANDOM()*1000000))::text,6,'0')` |
| 7 | Go repo has 8 order statuses, kept as-is (phase-04:50) | **PARTIAL** | 8 constants exist (`model/order.go:8-17`) including `pending`, but the plan's state diagram (phase-04:52-58) omits `pending`, which `sql_order_tx.go:44-47` sets whenever `reservation_expires_at` is nil. Phase 04 test #10 covers "mọi cặp (from,to)" over a set that is missing a state |
| 8 | Repo has **no migrations** (plan.md:34; phase-03:130) | **VERIFIED** | `find . -iname "*.sql"` → none |
| 9 | Repo has **no auth**, every endpoint public (phase-01:13; phase-11:69) | **VERIFIED** | `grep -rn "jwt\|Authorization\|bcrypt\|argon"` → only `password_hash` column plumbing; `module/order/transport/gin/routes.go:10-21` registers routes with no middleware; `main.go` wires only rate-limit middleware |
| 10 | Repo has **0 test files** (phase-11:70) | **VERIFIED** | `find . -name "*_test.go" \| wc -l` → 0 |
| 11 | Outbox: README describes 4 endpoints, module absent from source (phase-05:13; phase-11:71) | **VERIFIED** | `README.md:200-205` lists the 4 endpoints; `find . -ipath "*outbox*"` → no files |
| 12 | Adjust uses `SELECT … FOR UPDATE` + read-modify-write (phase-03:15,88) | **VERIFIED** | `sql_inventory.go:24-36,145-158` |
| 13 | Adjust auto-creates the inventory row; negative adjust on a missing row errors (phase-03:20,119-120) | **VERIFIED** | `sql_inventory.go:65-69` (`ErrInventoryNotEnoughStock`), `:70-110` (create branch), ledger written at `:112-128` |
| 14 | `inventory_transactions` has 15 columns, reconstructed exactly (phase-03:61-76,157) | **VERIFIED** | `sql_inventory_transaction.go:19-35` (13 insert cols) + `id`, `created_at` returned at `:35`; select list at `:80-95` matches the plan's column set 1:1 including `reason`, `created_by` |
| 15 | `inventory` columns reconstructed exactly (phase-03:49-59) | **VERIFIED** | `sql_inventory.go:25-33` — id, product_id, warehouse_id, available_qty, reserved_qty, version, created_at, updated_at. UNIQUE(product_id, warehouse_id) implied by `:264-277` lookup; the two `CHECK >= 0` are correctly flagged as **additions** (phase-03:82) |
| 16 | Plan's `inventory_reservations` matches the Go table (phase-04:142-153) | **PARTIAL** | Go columns verified at `sql_inventory_reservation.go:19-29,51-66`. The plan **adds** `expires_at`, `updated_at` handling and the `releasing` status (Go's model has no `expires_at` and no `releasing`: `model/inventory_reservation.go:8-22`). The additions are needed by Phase 05 but are **not listed** among the deliberate deviations in phase-04:232 or phase-11:60-74 |
| 17 | Payment already has `idempotency_key` + `external_txn_id` (phase-06:13,102) | **VERIFIED** | `module/payment/model/payment.go:14-16,26-27,51-52,62,82-84` |
| 18 | Redis rate limiter exists in the Go repo (phase-08:145) | **VERIFIED (repo) / FAILED (attribution)** | `component/ratelimit/limiter.go` and `middleware/ratelimit.go:12-36` exist; but "đã port ở Phase 00" is false — Phase 00 (`phase-00:80-98`) ports no limiter. See Finding 9 |
| 19 | AI-Harness has `adjudicateAgainst` covering `[scope, namespace]` (phase-07:113) | **VERIFIED** | `AI-Harness-Clone/apps/api/src/memory/consolidation.service.ts:162` — `const adjudicateAgainst = [scope, namespace];`, used at `:168` |
| 20 | `consolidated_through` progress marker, advanced in the claiming statement (phase-07:115) | **VERIFIED** | `db/init/005_consolidation_progress.sql:16`; `apps/api/src/session/session.service.ts:122-137` — single `UPDATE … SET consolidated_through = pending.newest … WHERE pending.n >= $2`, with the "new messages since last pass" gate exactly as described |
| 21 | Score floor 0.28, calibrated for Cohere Embed Multilingual v3 (phase-07:121) | **VERIFIED** | `apps/api/src/memory/retrieval.service.ts:29` (`minScore: 0.28`); `memory/strategy.config.ts:29` ("gap sits between 0.25 and 0.33, so the floors live at 0.28"), `:72,:89` |
| 22 | Embeddings are 1024-dim (phase-00:119; phase-07:130,134) | **VERIFIED** | `db/init/002_memory.sql:1,8` — `embedding vector(1024) NOT NULL` |
| 23 | README says multi-tenant/RBAC "not built; the namespace column and a guard slot are left in place" (phase-07:86) | **VERIFIED** | `AI-Harness-Clone/README.md:267`; schema comment at `db/init/002_memory.sql:5` |
| 24 | `MemoryStore` methods take namespace; plan makes it mandatory (phase-07:88-97) | **FAILED (as stated)** | `apps/api/src/memory/pgvector-memory.store.ts:184` — `supersede(ids: number[])` takes **no** namespace and filters only by id; `upsert(write)` takes it inside the payload, not as a parameter. The plan's rewritten interface also types ids as `string[]` against a `BIGSERIAL` key (`db/init/002_memory.sql:4`). See Finding 8 |

---

## Unresolved questions for the planner

1. **What is the read scope of an `internal`-org actor?** Nothing downstream is reviewable until this is written down (Finding 2). It changes Phase 01's port signatures, Phase 04's list/get, Phase 08's every tool, and acceptance criterion #4.
2. **Is `POST /payments/callback` `@Public()`?** If yes, Finding 3 is a live exploit on day one of Phase 06. If no, the `PaymentGateway` port is modelling something the system cannot actually receive.
3. **Who may approve a stock adjustment proposal, and may the proposer approve their own?** (Finding 4.)
4. **Where does the refresh token live, and who owns that decision — Phase 01 or Phase 09?** Phase 09 currently decides an auth-transport question outside the phase that owns the auth invariant (Finding 7).
5. `reservation_expires_at` default is still open (plan.md:149). Note it is also a security parameter, not only a business one: a long default plus Finding 3 widens the inventory-lock window.

---

Status: DONE_WITH_CONCERNS
Summary: The plan's factual base is solid — 20 of 23 sampled claims about both reference repos verified exactly, including the column-level schema reconstruction — but the security model has four Critical gaps (unowned copilot sessions, an undefined `internal`-org read scope that Phase 08 contradicts itself about, an unauthenticated/unsigned payment callback whose simulate switch is always on, and an unguarded proposal-approval path with no role-to-org-type binding) plus five High/Medium issues.
Concerns/Blockers: Acceptance criteria #4 and #5 (plan.md:96-97) are not achievable as written. Findings 1, 2 and 4 must be resolved in Phase 01/07 before Phase 08 starts, since they change interfaces, not just implementations.
