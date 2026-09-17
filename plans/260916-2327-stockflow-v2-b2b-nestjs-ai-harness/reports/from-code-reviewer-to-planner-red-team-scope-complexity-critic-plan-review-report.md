---
title: "Red-team plan review — Scope & Complexity Critic (YAGNI) + Contract Verifier"
reviewer: code-reviewer
lens: scope-and-complexity-critic
tier: full (contract verification)
date: 2026-09-17
target: plans/260916-2327-stockflow-v2-b2b-nestjs-ai-harness/
verdict: DONE_WITH_CONCERNS — 4 Critical, 3 High, 3 Medium
---

# Red-Team Plan Review — Scope & Complexity Critic

Scope: all 13 plan files (2,264 lines). Evidence cross-checked against the two read-only
reference repos (`StockFlow/StockFlow` = 6,241 Go LOC / 92 files verified; `AI-Harness-Clone`
= 2,816 TS LOC in `apps/api/src` verified).

Headline: this plan is unusually well-argued prose sitting on top of **four cross-phase contracts
that cannot both be true**. Three of them silently kill a whole learning chapter. The over-engineering
is real but secondary — the contract breaks are what will actually stop the build.

---

## Finding 1: The `internal` org has no read path — ops console and 6 of 7 copilot tools return empty

- **Severity:** Critical
- **Location:** Phase 01 "Architecture"/"Tests First"; Phase 04 step 12; Phase 08 "Bảng tool"; plan.md "Acceptance criteria"

**Flaw.** The plan makes org scoping mandatory and absolute, then builds two entire features on top of
cross-org reads that the scoping rule forbids, and never defines the exception.

- `phase-01-identity-auth-rbac.md:27` — "Repository nhận `orgId` **tường minh qua tham số**… Quên truyền = lỗi compile."
- `phase-01-identity-auth-rbac.md:114` — test #5: "User A gọi get-by-id resource của B ⇒ **404**."
- `phase-01-identity-auth-rbac.md:139` — success criterion: "Không có method repository nào đọc dữ liệu thuộc org mà thiếu tham số `orgId`."
- `phase-04-ordering-atomic-reservation.md:243` — "**Mọi method nhận `Actor` làm tham số đầu và tự scope org**."
- `plan.md:96` — acceptance #4: "user org A không đọc được order/giá/memory của org B qua **bất kỳ endpoint nào**, kể cả copilot."

Ops users live in the `internal` org (`phase-01-identity-auth-rbac.md:18,128` — seed = 1 internal org
+ 2 buyer orgs). Orders are keyed by `buyer_org_id` (`phase-04-ordering-atomic-reservation.md:118`).
So `OrderService.list(actor…)` scoped to `actor.orgId` = the internal org returns **zero rows**,
because the internal org never places orders — `phase-04-ordering-atomic-reservation.md:67` explicitly
rejects it: "AuthZ `actor.orgType === 'buyer'`".

I grepped every occurrence of `internal` / `orgType` across all 13 files. It is used in exactly two
places: rejecting order creation (`phase-04…:67`) and choosing a frontend layout
(`phase-10-buyer-portal.md:53`). **No phase anywhere states that `orgType === 'internal'` bypasses
org scoping, or which resources are org-owned at all.** There are already six different de-facto
scoping rules in the schema with no rule table: `orders.buyer_org_id` (required),
`price_lists.org_id` (nullable = default list, `phase-02…:95`), `inventory` (no org column at all,
`phase-03-inventory-core-ledger.md:49-59`), `products`/`warehouses` (no org column,
`phase-02…:81-90`), `audit_log.org_id` (nullable, `phase-05…:113`), `ai.memories` (namespace string,
`phase-07…:90`).

**Failure scenario.** Day 1 of Phase 08 the dev writes `find_orders`, runs it with the seeded `ops`
user, and gets `[]`. The fix is a one-line "if internal, skip the org filter" — which is exactly the
kind of ad-hoc escape hatch Phase 01 spent three days and six tests building a compile-time guarantee
against. Chapter 4 (multi-tenant boundary) degrades from "structural" to "a boolean somebody
remembered to check", and acceptance criterion #4 as literally written can never be ticked, because
the ops console itself violates it.

**Evidence.** `plan.md:96`; `phase-01-identity-auth-rbac.md:27,114,139`;
`phase-04-ordering-atomic-reservation.md:67,118,243`; `phase-08-ops-copilot.md:82-86`;
`phase-10-buyer-portal.md:53`. Grep for `internal|orgType` across `phase-*.md` returns 11 hits, none
of which define a cross-org read rule.

**Suggested fix.** Add to Phase 01, before anything else is built: an explicit **resource-scoping
table** (resource → owning org column → who may read cross-org) and a single named primitive, e.g.
`OrgScope = {kind:'own', orgId} | {kind:'supplier'}`, derived from `Actor` in one place and passed
where `orgId: string` is passed today. Rewrite acceptance #4 as "a **buyer** org A user cannot read
org B data". This is a ~half-day change in Phase 01 and saves the ad-hoc patch in Phase 08.

---

## Finding 2: The reservation sweeper and `ExpireOrderUseCase` contradict each other — expired stock is never released

- **Severity:** Critical
- **Location:** Phase 05 "Reservation expiry job" vs Phase 04 "Luồng huỷ / hết hạn"

**Flaw.** Phase 05's job claims reservations by flipping `held → releasing`, then delegates to
Phase 04's use case — which only acts on rows still in `held`.

Phase 05 (`phase-05-outbox-relay-scheduler.md:84-90`):

```
UPDATE inventory_reservations SET status='releasing'
 WHERE id IN (SELECT id … WHERE status='held' AND expires_at < now() … FOR UPDATE SKIP LOCKED)
RETURNING * → nhóm theo order_id → với mỗi order: gọi ExpireOrderUseCase (đã idempotent từ Phase 04)
```

Phase 04 (`phase-04-ordering-atomic-reservation.md:102-105`):

```
cho từng reservation status='held' của đơn (ORDER BY product_id):
    releaseAtomic(tx, …)   /  ledger.append('release')  /  reservation.status='released'
```

By the time `ExpireOrderUseCase` runs, the sweeper has already moved every target row out of `held`.
The loop iterates zero rows. Result: order flips to `expired`, **no** `releaseAtomic`, **no** ledger
row, **no** stock returned, and the reservations are stranded in `releasing` forever — nothing in
either phase ever transitions out of `releasing`, even though the check constraint allows it
(`phase-04-ordering-atomic-reservation.md:149`).

Worse, Phase 04's own idempotency guard makes this silent: `phase-04…:100` — "status đã là
cancelled/expired? ⇒ trả về nguyên trạng, **KHÔNG lỗi**". A subsequent manual expire also does nothing.

**Failure scenario.** `phase-05-outbox-relay-scheduler.md:147` (test #6, tagged ACCEPTANCE CRITERIA #3)
goes red and stays red. The dev's natural fix is to widen Phase 04's loop to `status IN ('held','releasing')`
— which reintroduces the double-release race that the `releasing` marker existed to prevent, and
`phase-05…:149` (test #8, two concurrent sweepers on 50 reservations) then goes red instead. This is
a 1–2 day debugging detour in a phase budgeted at 2 days total (`plan.md:46`), and the rationale prose
at `phase-05…:94` ("Trạng thái trung gian `releasing` là cái chốt chống xử lý trùng") will read as
correct the whole time.

**Evidence.** `phase-04-ordering-atomic-reservation.md:100-105,149`;
`phase-05-outbox-relay-scheduler.md:84-90,94,147,149,159`.

**Suggested fix.** Pick one owner of the claim. Cleanest: the sweeper claims **orders**, not
reservations (`UPDATE orders SET status='expiring' WHERE status IN ('reserved','awaiting_payment')
AND reservation_expires_at < now() … SKIP LOCKED`), and `ExpireOrderUseCase` keeps sole ownership of
the `held → released` transition. Then Phase 04 needs no change and `releasing` can be deleted from
the constraint entirely — one fewer state.

---

## Finding 3: Phase 00's `platform/` ↔ `modules/` lint rule makes Phase 05 uncompilable, and it is a Phase 00 gate

- **Severity:** Critical
- **Location:** Phase 00 "Architecture" (ESLint) vs Phase 05 "Architecture"

**Flaw.** `phase-00-foundation-and-bedrock-spike.md:75` declares a hard boundary:

```
"apps/api/src/platform/**": cấm import "**/modules/**"
```

and `phase-00…:57` restates it in prose ("`platform/` không được import từ `modules/`"), and
`phase-00…:138` makes lint enforcement a success criterion.

Phase 05 then places two components under `platform/` that must reach into `modules/`:

- `platform/scheduler/reservation-expiry.job.ts` (`phase-05-outbox-relay-scheduler.md:43`) must call
  `ExpireOrderUseCase` (`phase-05…:90,159`), which lives at
  `modules/ordering/application/use-cases/expire-order.ts` (`phase-04-ordering-atomic-reservation.md:41`).
- `platform/outbox/outbox.dispatcher.ts` (`phase-05…:35-36`) must be handed `AuditLogHandler` from
  `modules/audit/` (`phase-05…:45,158`) and must route `order.*` / `inventory.*` event types
  (`phase-05…:158`) — which is domain knowledge living in a directory Phase 00 defines as
  "hạ tầng dùng chung, **KHÔNG chứa nghiệp vụ**" (`phase-00…:37`).

**Failure scenario.** Phase 05 day 1: `pnpm lint` fails. The three available moves are (a) delete the
lint rule — which also deletes the Phase 00 success criterion and the `docs/code-standards.md` rule
written on day 1 (`phase-00…:97,127`); (b) add an eslint-disable — exactly the "lint suppression"
smell the plan otherwise polices; (c) invent a port + DI token indirection that Phase 05 never budgets
for. Most likely outcome is (a) or (b), after which the `modules/copilot` and `ai-harness` rules in the
same config lose credibility too, because "we already turned one off."

**Evidence.** `phase-00-foundation-and-bedrock-spike.md:37,57,70-76,138`;
`phase-04-ordering-atomic-reservation.md:41`;
`phase-05-outbox-relay-scheduler.md:34-46,90,158,159`.

**Suggested fix.** Move both to `modules/`: the sweeper belongs to `modules/ordering` (it is an
ordering policy), and the audit handler registration belongs to `modules/audit`. Keep in
`platform/outbox` only the mechanism (relay claim loop + dispatcher interface) with **zero** knowledge
of event-type names — the dispatcher should be a map populated by DI, not a file that spells
`order.*`. That restores the rule without weakening it, and is strictly less code.

---

## Finding 4: Chapter 5's core mechanism is undefined — `ToolDefinition` (boot-time) vs `ToolFactory` (per-request), plus four never-specified types

- **Severity:** Critical
- **Location:** Phase 07 "Ba thay đổi thực chất" / "AgentRuntime"; Phase 08 "Hợp đồng tool"

**Flaw — the mismatch is real.** Phase 07 accepts tools at **module boot**:
`phase-07-ai-harness-package.md:74-80` — `AiHarnessModule.forRoot({ agents, strategies, tools: ToolDefinition[], memoryStore, llm })`,
and `phase-07…:49` — "`tool.registry.ts` # nhận tool qua DI, không hardcode".

Phase 08 requires tools built **per request**, bound to the caller's `Actor`:
`phase-08-ops-copilot.md:61-68` — `makeGetInventoryStatusTool(inventory): ToolFactory` returning
`(actor: Actor) => ({name, description, schema, handler})`; `phase-08…:73` — "Tool instance được dựng
**cho từng request** với actor của người đang chat"; `phase-08…:186` — "Dựng tool instance **cho
từng request** với actor hiện tại."

`ToolFactory` appears only in Phase 08 (`:61,181`). `ToolDefinition` appears only in Phase 07
(`:77,182`). **No API in Phase 07 accepts per-request tools.** `AgentRuntime.run(input: RunInput)`
(`phase-07…:103`) is the only candidate — and `RunInput`, `RunResult`, `RunEvent`, `AgentDefinition`
and `StrategyDefinition` are named but **never specified anywhere in the plan** (grep: 0 shape
definitions). The same hole applies to memory: `phase-08…:94-97` needs a per-request namespace
`org:${orgId}`, but `forRoot` (`phase-07…:74-80`) has no namespace parameter and `MemoryStore`
(`phase-07…:89-95`) is a boot-time provider. The single most-advertised property of the whole
project — "agent không có quyền cao hơn user" (`plan.md:28,97`) — has no declared plumbing.

**Flaw — the unverified dependency behind it.** `phase-08-ops-copilot.md:25` requires SSE to emit
`tool_start`/`tool_end`; `phase-08…:172` (test #13) and the entire Phase 09 demo axis depend on it
(`phase-09-web-ops-console.md:82-87` — "Badge tool là chi tiết khiến copilot đáng tin";
`phase-09…:149` success criterion). That requires the **real** runtime to expose per-tool lifecycle
events. Phase 07's insurance test #9 (`phase-07…:169`) uses a **fake** runtime, so it proves nothing
about Strands. Phase 00's de-risking spike covers only "chat trả lời được, embedding đúng 1024 chiều"
(`phase-00…:119,132`) — it does not touch tool-calling or event streaming at all.

**Failure scenario.** Week 6, Phase 08 day 2. The dev discovers `forRoot` can't take a closure over a
request-scoped `Actor`, and retrofits either NestJS `Scope.REQUEST` through the whole harness (which
re-instantiates `MemoryStore`, `RetrievalService` and the pg pool per request) or an
`AsyncLocalStorage` actor context — the exact thing `phase-01-identity-auth-rbac.md:27` banned
("không đọc từ global/async-local state"). Then in Phase 09 they find Strands v1.10 doesn't surface
tool events, and the headline demo screen has no content. Both are discovered at the point of maximum
sunk cost, in the two phases (07: 3 days, 08: 3–4 days, `plan.md:48-49`) with the least slack.

**Evidence.** `phase-07-ai-harness-package.md:49,74-80,89-95,103-104,169`;
`phase-08-ops-copilot.md:25,61-68,73,94-97,172,186`; `phase-09-web-ops-console.md:82-87,149`;
`phase-00-foundation-and-bedrock-spike.md:119,132`; `plan.md:28,97`.

**Suggested fix.** Two changes, both cheap if made now:

1. Specify the five types in Phase 07 before anything else, and make the actor-carrying seam explicit:
   `forRoot({ agents, llm, memoryStore })` for boot-time wiring; `runtime.stream({ agentId, namespace,
   tools: ToolDefinition[], messages })` for per-request. `ToolFactory` then lives entirely in Phase 08
   as `(actor) => ToolDefinition` — the harness never learns the word `Actor`, which is what you wanted
   anyway.
2. Extend the Phase 00 spike (`phase-00…:119`) to call one tool through the real runtime and assert a
   tool-start/tool-end event is observable. That is ~40 extra lines in `scripts/spike-bedrock.ts` and
   moves the project's largest unknown from week 6 to day 1 — which is the stated purpose of that spike.

---

## Finding 5: The 3-resolver chain contradicts the "exactly 1 query" gate it sits next to — premature strategy pattern

- **Severity:** High
- **Location:** Phase 02 "Chain of resolvers" / "Tests First" #7 / "Success Criteria"

**Flaw.** Phase 02 states three things that cannot all hold:

- `phase-02-catalog-warehouse-pricing.md:73` — "`ChainPriceResolver` chạy **lần lượt**: `ContractPriceResolver` → `DefaultListResolver` → `BasePriceResolver`, **dừng ở resolver đầu tiên** có giá."
- `phase-02…:141` (test #7) — "resolve 20 product ⇒ đếm số query thực thi **= 1** (spy trên pool)"; restated as a gate at `phase-02…:28,161,174`.
- `phase-02…:84` / `:93-107` — `base_price` lives on `products`; contract and default lists live on `price_lists`/`price_list_items`. **Different tables.**

A chain that short-circuits per product cannot also be one query; and a `base_price` fallback cannot
come from the `price_lists` query at all without a JOIN to `products`. `phase-02…:152` resolves the
tension by making the repository do "**một query** trả về mọi candidate row … kèm đủ cột để xếp hạng
ở tầng application" — at which point the three "resolvers" do no I/O and no dispatch. They are three
classes that each filter an in-memory array by `sourceKind`, wrapped in a fourth class that calls them
in order. That is a strategy pattern over an `Array.find`.

**Cost of the ceremony, counted.** `phase-02…:38-43` implies for `modules/pricing`:
2 port files + 3 resolver files + `chain-price-resolver.ts` + 4 use-case files + 5 domain files +
1 infra + 1 http ≈ 17 source files, plus 8 test specs (`phase-02…:135-142`), plus ADR 0007
(`phase-02…:122`), inside a 3-day phase (`plan.md:43`) that *also* ports product (710 Go LOC) and
warehouse (671 Go LOC) — both verified by counting the reference repo.

**What is actually worth learning here** is real and I am not asking to delete it: server-authoritative
pricing, the `price_list_item_id` audit trail, deterministic tie-breaking to `id ASC`
(`phase-02…:114`), and the quantity-break boundary table (`phase-02…:136`). None of that requires a
chain. The stated payoff — `phase-02…:75` "Thêm khuyến mãi = thêm một resolver… Không sửa một dòng
nào trong `modules/ordering`" — is delivered by the `PriceResolver` **port** alone
(`phase-02…:63-65`), which `modules/ordering` already depends on. The chain adds zero isolation on top.

**Failure scenario.** Either test #7 stays red until the "chain" is collapsed into one SQL statement
(and the three classes become dead decoration that Phase 11 step 1 is then supposed to delete —
`phase-11…:119` "Xoá code chết"), or the dev weakens test #7 to "≤ 3 queries" and the N+1 gate that
Phase 04 explicitly leans on (`phase-02…:28` — "Phase 04 gọi trong transaction — N+1 ở đó là tự sát")
is gone.

**Evidence.** `phase-02-catalog-warehouse-pricing.md:28,38-43,63-65,73,75,84,93-107,114,136,141,152,161,173,174`;
`plan.md:43,104`.

**Suggested fix.** Keep the `PriceResolver` **interface** and `ResolvedPrice.sourceKind`. Delete
`ChainPriceResolver` and the three resolver classes. Implement as: one repository method returning
candidate rows (lists JOIN products for base price) + one **pure** ranking function
`pickPrice(candidates, qty): ResolvedPrice` that the existing tests #2/#3/#5 already target as a pure
function (`phase-02…:153`). Net: −5 files, test #7 becomes satisfiable, ADR 0007 becomes "why one
query + one pure function instead of a rule engine" — a better lesson than the chain.

---

## Finding 6: Phase 04 cannot reach `paid`, so two of its own tests are unrunnable; and 2 of the 8 order states have no producer

- **Severity:** High
- **Location:** Phase 04 "State machine" + tests #4/#11; Phase 06 "Related Code Files"; Phase 09 test #4

**Flaw A — missing transition.** The state machine (`phase-04-ordering-atomic-reservation.md:54`) is
`reserved → awaiting_payment → paid → fulfilled → completed`. The only transition into `paid` is
`OrderService.markPaid`, and it is declared in **Phase 06**:
`phase-06-payment-simulated.md:97` — "**Modify** … `order.service.ts` — thêm `markPaid`"; `:62,129`.
But Phase 04 ships `POST /orders/:id/fulfill` (`phase-04…:24`) and two tests that require a paid order:

- `phase-04…:221` test #11 `fulfill-consumes.spec.ts`
- `phase-04…:208` test #4 `invariant-sum.spec.ts` — "chuỗi ngẫu nhiên create/cancel/expire/**fulfill**"

Phase 04 has no way to put an order into `paid`. The tests can only pass via a raw-SQL backdoor in the
fixture — i.e. a test that bypasses the state machine it is supposed to be proving, which is the
definition of a phantom test.

**Flaw B — dead states.** I verified against the Go source: the 8 statuses at
`StockFlow/module/order/model/order.go:9-16` are `pending, reserved, awaiting_payment, paid,
fulfilled, completed, cancelled, expired`, and `phase-04…:50` claims "giữ nguyên 8 trạng thái".
But in the v2 flow **`pending` has no producer** — Phase 04 always reserves, so orders are born
`reserved` (`phase-04…:54`) — and **`completed` has no producer** — nothing in Phase 04, 05 or 06
transitions `fulfilled → completed`. Yet `phase-09-web-ops-console.md:119` (test #4) asserts the UI
renders "đúng trạng thái hiện tại và đường hợp lệ cho **cả 8 status**", and `phase-09…:150` makes it a
success criterion. You are building, testing and hand-drawing an SVG for two states no code path can
ever reach.

(For context on Flaw B's origin: in the Go repo `pending` is real — `sql_order_tx.go:44-47` sets
`pending` when `reservation_expires_at` is nil. v2 removes that branch and inherits the state anyway.)

**Failure scenario.** Phase 04 is "trái tim của project" (`phase-04…:13`) at 4 days with 15 tests.
Two of them are blocked on a phase that is P2 and 4 phases away. The dev writes an `UPDATE orders SET
status='paid'` in a test helper, moves on, and the ledger-invariant test #4 — the one that would catch
a consume/release accounting bug — is now validating a state the system can't actually produce.

**Evidence.** `phase-04-ordering-atomic-reservation.md:13,24,50,54,208,221`;
`phase-06-payment-simulated.md:62,97,129`; `phase-09-web-ops-console.md:119,150`;
`StockFlow/module/order/model/order.go:9-16`; `StockFlow/module/order/storage/sql_order_tx.go:44-47`.

**Suggested fix.** Move `markPaid` into Phase 04 as a 1-endpoint, ops-only `POST /orders/:id/mark-paid`
(~60 lines: state-machine check + outbox row). Test #11 and #4 become runnable in their own phase, and
Phase 06 shrinks to "point the callback at an endpoint that already exists" — see Finding 8 and the
Minimum Viable Plan. Separately: delete `pending` and `completed` from the v2 state set, or give them
producers. Record the deletion in `docs/decisions-vs-stockflow.md` (`phase-11…:56`) — "we deliberately
dropped 2 of the Go repo's 8 states because nothing produced them" is a better entry than silently
drawing them.

---

## Finding 7: Outbox carries two sources of truth for one fact, and the relay's hot query cannot use either index

- **Severity:** High
- **Location:** Phase 04 schema (`006_ordering.sql`) vs Phase 05 schema (`007_outbox_audit.sql`) + relay loop

**Flaw.** Phase 04 creates `outbox_events` with `processed_at` as the done-marker and a matching
partial index (`phase-04-ordering-atomic-reservation.md:157-162`):

```
processed_at timestamptz, attempts int not null default 0, last_error text
create index on outbox_events (processed_at, id) where processed_at is null;
```

Phase 05 then bolts on a **second** representation of the same fact
(`phase-05-outbox-relay-scheduler.md:101-106`):

```
add column status text not null default 'pending' check (status in ('pending','processed','dead'))
create index on outbox_events (status, next_attempt_at, id) where status = 'pending';
```

Three concrete consequences:

1. **The claim query matches neither index.** `phase-05…:53-62` filters on
   `processed_at IS NULL AND attempts < $maxAttempts AND (next_attempt_at IS NULL OR next_attempt_at <= now())`.
   The new index's predicate is `WHERE status='pending'` — Postgres cannot prove `status='pending'`
   from `processed_at IS NULL`, so it will not use it. Phase 04's index doesn't cover `attempts` or
   `next_attempt_at`. The relay's only hot-path query runs unindexed.
2. **`status` is never set to `'processed'`.** `phase-05…:64` — "Thành công ⇒ `processed_at = now()`."
   No step anywhere writes `status='processed'`. So the `WHERE status='pending'` partial index
   monotonically accumulates every event ever emitted, and `GET /ops/outbox?status=dead`
   (`phase-05…:161`) plus the Phase 09 dashboard tile (`phase-09…:23`) read a column the relay
   half-maintains.
3. **`status='dead'` and `processed_at IS NULL` are simultaneously true forever**, so dead events are
   permanently re-selected by the claim query's own predicate — defeating test #4
   (`phase-05…:145`, "event lỗi không chặn hàng đợi") unless `attempts < $maxAttempts` is doing all
   the work, in which case the `status` column buys nothing at all.

**On whether the outbox belongs in v1 at all:** it is learning chapter 3 (`plan.md:26`) and it
genuinely teaches `SKIP LOCKED`, at-least-once and consumer idempotency — I am not recommending the cut.
But the price should be honest. Counted from `phase-05…:33-47,98-119,123-129,140-150,161`: 4 relay/
dispatcher files + 3 scheduler files + a 4-layer `modules/audit` (≈8 files, see Finding 9) + migration
007 + 2 ADRs + 9 test specs (2 of them multi-worker concurrency tests) + 1 ops endpoint + 1 dashboard
tile ≈ **28 artifacts, budgeted at 2 days** (`plan.md:46`). That is not a 2-day phase.

**Failure scenario.** Everything passes at seed scale, because 20 events fit in a page. The design
defect never surfaces during the project; the dev writes ADR 0012 asserting the design is sound
(`phase-05…:172`) and learns the wrong lesson from the chapter whose entire point is durable
asynchronous state.

**Evidence.** `phase-04-ordering-atomic-reservation.md:157-162`;
`phase-05-outbox-relay-scheduler.md:53-64,101-106,145,161,172`; `phase-09-web-ops-console.md:23`;
`plan.md:26,46`.

**Suggested fix.** One column, not two. Drop `processed_at` in migration 007 (or drop `status` and keep
`processed_at` + a `dead_at`), and make the claim query's `WHERE` clause **textually identical** to the
partial index predicate. Note the rule in ADR 0012: a partial index only helps when its predicate is
implied by the query's. Budget Phase 05 at 3–4 days, or apply the `modules/audit` cut in Finding 9.

---

## Finding 8: YAGNI cluster — `org_members` with no org switching, `Money` with half a currency model

- **Severity:** Medium
- **Location:** Phase 01 "Schema"; Phase 02 "`Money` value object"

**(a) `org_members` is justified by a capability the plan makes impossible.**
`phase-01-identity-auth-rbac.md:85` — "chi phí gần bằng 0 hôm nay, nhưng mở sẵn đường cho **một user
thuộc nhiều tổ chức**". But `Actor.orgId` is a **singular string** (`phase-01…:51`), login takes only
email + password with no org parameter (`phase-01…:20,125`), the token carries one `orgId`
(`phase-01…:115`, test #6), and there is no org-switch endpoint in any of the 13 files (grepped).
So if a user ever has two memberships, **which `orgId` goes in the token is undefined behaviour** —
the composite PK `(org_id, user_id)` (`phase-01…:77`) guarantees the login query can return 2 rows and
nothing says which wins. The table does not open the door; it just makes every user lookup a join.
The cost isn't zero: it's a join in `login`, in `create-user`, in `list-users`, in `getUser`, in
`updateUser` (`phase-01…:125`), plus an extra repository and test surface.

**(b) `Money` claims a multi-currency model it cannot implement.** `phase-02…:50-57` defines
`Money(minor: bigint, currency: string)` with `add()` that "ném lỗi nếu khác currency" (`:56`). There
are four `currency char(3)` columns — `products` (`phase-02…:85`), `price_lists` (`:96`), `orders`
(`phase-04…:124`), `payments` (`phase-06…:74`) — but **no currency→exponent table anywhere**, and the
VO constructor takes no scale. Every column is `numeric(18,2)` and the seed currency is VND
(`phase-02…:85`), which has **no minor unit** — so `fromDecimalString`/`toDecimalString`
(`phase-02…:53-54`) round-trip through two decimals that VND does not have, and `fromMinor` means
something different per currency with no way to express it. Nothing in the plan ever creates a
non-VND price list, and there is no FX table or conversion path. This is enough multi-currency to be
wrong, not enough to work.

The invariant that actually matters — `plan.md:99` "không có kiểu float biểu diễn tiền ở bất kỳ tầng
nào" — is delivered by two things already in the plan: configuring `pg` not to parse `numeric`
(`phase-02…:59,148`) and a branded string type. The class is optional.

**Failure scenario.** Low-drama but persistent: an extra join on every identity read path forever, and
a `Money` API where `Money.fromMinor(50000n,'VND')` and `Money.fromDecimalString('50000.00','VND')`
have to mean the same thing while the type system says nothing. Test #1 (`phase-02…:135`) passes
because it only exercises 2-decimal round-trips, which is exactly the case where the ambiguity hides.

**Evidence.** `phase-01-identity-auth-rbac.md:20,51,73-77,85,115,125`;
`phase-02-catalog-warehouse-pricing.md:50-59,85,96,135,148`;
`phase-04-ordering-atomic-reservation.md:124`; `phase-06-payment-simulated.md:74`; `plan.md:99`.

**Suggested fix.** Replace `org_members` with `users.org_id` + `users.role` (−1 table, −1 repository,
−5 joins) and put "one user, one org; multi-org needs a token-scoped org switch we deliberately did
not build" in ADR 0004 — which is a more honest ADR than the current one. For money: either add a
`CURRENCY_EXPONENT` map and a scale-aware constructor (30 lines, makes the VO honest), or drop to
`type MinorUnits = bigint & {__brand:'minor'}` + 4 free functions and delete `currency` from
three of the four tables. Do not ship the middle version.

---

## Finding 9: Ceremony budget — 4-layer modules for a 5-column lookup table and an append-only log

- **Severity:** Medium
- **Location:** Phase 02 `modules/warehouse`; Phase 05 `modules/audit`

**Flaw.** `plan.md:113` mandates the 4-layer shape for every module. Two of the nine modules have no
domain, no invariant, and no learning chapter attached:

- `phase-02-catalog-warehouse-pricing.md:34` — `modules/warehouse/ domain/ application/ infrastructure/ http/`
  for a table with 5 business columns (`phase-02…:87-89`: `code, name, address, is_active` + id) and
  4 CRUD operations (`phase-02…:19`), whose only rule is "uppercase + trim the code"
  (`phase-02…:142`). Implied: a `domain/warehouse.ts` with no invariant, a `ports/warehouse.repository.ts`,
  4 use-case files, an infra file, a controller and ~4 DTOs ≈ **14 files**. The Go original is 671 LOC
  in 12 files (verified) and it teaches nothing v2 hasn't already taught in `catalog`, which is the
  identical shape.
- `phase-05-outbox-relay-scheduler.md:45-46` — `modules/audit/ domain/ application/ infrastructure/ http/`
  for `audit_log` (`phase-05…:108-116`), which is written by exactly one handler doing
  `INSERT … ON CONFLICT (event_id) DO NOTHING` (`phase-05…:119,158`) and read by one timeline query
  (`phase-09…:91`). A `domain/` layer for a table with no behaviour and no invariant beyond a UNIQUE
  constraint ≈ another **8 files**.

**Scale context, counted.** The plan implies roughly 9 modules × 4 layers (+ `ports/`, `use-cases/`,
`dto/` subdirs) ≈ **63 directories under `modules/`**, plus 10 `platform/` subsystems (6 declared at
`phase-00…:38-43`, then `auth` at `phase-01…:94`, `idempotency` at `phase-04…:184`, `outbox` and
`scheduler` at `phase-05…:34,41`), plus 7 in `packages/ai-harness` (`phase-07…:36-64`), plus ~20 in
`apps/web` (`phase-09…:41-64`, `phase-10…:38-48`) ≈ **100 directories and ~450–470 source files** —
derived from a verified 6,241 Go LOC + 2,816 TS LOC of reference material. Note `phase-00…:148`
promises "Không thêm abstraction nào chưa có người dùng"; `platform/` grows from 6 to 10 subsystems by
Phase 05 without that promise being revisited.

**Failure scenario.** Not failure — friction. ~22 files of pure indirection, each needing a DI
registration in `app.module.ts` (modified in 6 phases: `phase-01…:100`, `phase-02…:125`,
`phase-03…:108`, `phase-05…:132`, `phase-06…:96`, `phase-08…:135`), and the `warehouse` module in
particular consumes ~1 of Phase 02's 3 days that the pricing engine — the actual chapter — needs.

**Evidence.** `plan.md:113`; `phase-00-foundation-and-bedrock-spike.md:38-43,148`;
`phase-02-catalog-warehouse-pricing.md:19,34,87-89,142`;
`phase-05-outbox-relay-scheduler.md:45-46,108-119,158`; `phase-07-ai-harness-package.md:36-64`;
`phase-09-web-ops-console.md:41-64,91`; reference repo `module/warehouse/` = 671 LOC / 12 files.

**Suggested fix.** Fold `warehouse` into `modules/catalog` as `catalog/domain/warehouse.ts` +
`catalog/infrastructure/sql-warehouse.repository.ts` + 4 routes on the existing controller (−10 files,
~0.5 day back). Reduce `modules/audit` to `audit/audit-log.handler.ts` + `audit/sql-audit.repository.ts`
and note in `docs/code-standards.md` that 4-layer applies to modules **with domain invariants** —
which is a defensible architectural rule, not an exception.

---

## Finding 10: `verify-architecture.sh` checks a different set of 5 things than `plan.md` promises, and 2 of them are manual

- **Severity:** Medium
- **Location:** Phase 11 "`scripts/verify-architecture.sh`" vs plan.md "Chỉ báo chất lượng kiến trúc"

**Flaw.** `plan.md:102` promises 5 indicators; `phase-11-docs-diagrams-hardening.md:27` requires that
they "phải **chạy được như một script**, không phải lời hứa"; `phase-11…:133` makes `exit 0` a success
criterion. The script (`phase-11…:79-87`) does not match:

| plan.md:104-108 | in `verify-architecture.sh`? |
|---|---|
| #1 new price resolver doesn't touch `modules/ordering` | comment only, manual git-diff (`phase-11…:85,88`) |
| #2 new copilot tool doesn't touch `ai-harness` | comment only, manual git-diff (`phase-11…:86,88`) |
| #3 new LLM model ⇒ only `config/litellm/config.yaml` | **absent** |
| #4 no SQL in `modules/copilot` | `phase-11…:80` |
| #5 no float money anywhere in repo | `phase-11…:84` |
| — | `phase-11…:82` "ai-harness không biết apps/" — **not one of plan.md's 5** |

So: 2 of 5 automated, 1 dropped, 1 substituted. Additional defects in the 3 that exist:

- `phase-11…:80` uses brace expansion `modules/copilot/{application,http}/` in a file named `.sh`.
  Under `sh`/`dash` braces don't expand and the grep silently targets a non-existent path — the gate
  **passes on a directory that doesn't exist**. Same pattern is a success criterion at `phase-08…:196`.
- `phase-11…:84` scans `apps/api/src packages/` only. `plan.md:108` says "trong **toàn repo**".
  `apps/web` is excluded — and that is where Phase 10's cart arithmetic lives
  (`phase-10…:57-67,102`). The regex `(price|amount|total|subtotal)\s*:\s*number` also misses the
  most likely real leak, `unitPrice: z.number()` in `packages/contracts` zod schemas, which is exactly
  the FE/BE boundary the rule exists to guard.
- No `set -e`, no trailing `exit 0`; the script's exit status is whatever the last `grep` returns
  (0 = match found = violation!). As written, a clean repo exits **1** and a repo with a float money
  field exits **1** too.
- `phase-11…:88` — "kiểm bằng cách **thật sự làm thử**: tạo một branch, thêm một resolver và một tool,
  xem `git diff --name-only`". This is ceremony: you are writing throwaway code to observe that your
  own import graph is what you wrote it to be. The same fact is provable statically (`grep -rn
  "modules/pricing" apps/api/src/modules/ordering/` must be empty) for a fraction of the cost.
  Note Phase 08 already does the honest version of this check by adding a real 8th tool as a test
  (`phase-08…:201`) — that one earns its keep; the git-diff dance does not.

**Failure scenario.** Phase 11 day 2, the script exits 1 on a clean repo. The dev "fixes" it by
appending `exit 0`, and the gate that was supposed to be the project's architectural conscience becomes
a script that always passes.

**Evidence.** `plan.md:102-108`; `phase-08-ops-copilot.md:196,201`;
`phase-10-buyer-portal.md:57-67,102`; `phase-11-docs-diagrams-hardening.md:27,79-88,133,137`.

**Suggested fix.** Write the script in Phase 00 alongside the ESLint rules, not in Phase 11 — a gate
introduced in the last phase has no chance to prevent anything. Make it `#!/usr/bin/env bash`,
`set -uo pipefail`, one `fail()` helper, explicit `exit $rc`. Replace indicators #1/#2 with static
import-graph greps. Either implement #3 or delete it from `plan.md:106`.

---

## Contract Verification Results

Every declared cross-phase interface, with every consumer enumerated.

| # | Contract | Declared at | Consumed at | Verdict |
|---|---|---|---|---|
| 1 | `Tx`, `UnitOfWork.withTransaction` | `phase-00…:63-66` | `phase-03…:94` (`reserveAtomic(tx: Tx, …)`), `phase-03…:137`, `phase-04…:239`, `phase-05…` (relay claim, no explicit use), `phase-06…:127-128` | **MATCH** on shape. **GAP:** `Tx.query<T>` returns `Promise<T[]>` with no `rowCount`; `phase-03…:93,97` and `phase-04…:78` depend on "0 row affected ⇒ null", which `RETURNING` + empty array covers — but `phase-05…:53-62` (`UPDATE … RETURNING *`) and `phase-06…:128` (`ON CONFLICT DO NOTHING`) rely on the same. Works, but state it. Phase 05's relay/scheduler never say whether they use `UnitOfWork` or raw pool. |
| 2 | `InventoryRepository.reserveAtomic / releaseAtomic / consumeAtomic` | `phase-03…:93-97` (only `reserveAtomic` has a full signature), `phase-03…:134` (all three named) | `phase-04…:77` (`reserveAtomic(tx, productId, warehouseId, qty)`), `phase-04…:104` (`releaseAtomic(tx, …)`), `phase-04…:241` (`consumeAtomic`), `phase-04…:192` | **MATCH** for `reserveAtomic` (4 args, identical). **MISMATCH (unspecified):** `releaseAtomic` and `consumeAtomic` have **no declared signature** in Phase 03 despite `phase-03…:158` claiming "nó được định nghĩa và test **ở phase này**". Phase 03 test #5 (`:123`) covers only `reserveAtomic`. `consumeAtomic` must decrement `reserved` without touching `available` (`phase-04…:221`) — a different return shape from `reserveAtomic`. Declare both. |
| 3 | `InventoryService.getStatus` | `phase-03…:24,138` (named, no signature; "Nhận `Actor` làm tham số đầu") | `phase-08…:66` — `inventory.getStatus(actor, input)` where `input = {sku, warehouseCode?}` (`phase-08…:65`), `phase-08…:81,180` | **MISMATCH.** Phase 03 exposes inventory by `product_id`/`warehouse_id` only (`phase-03…:21`); `InventoryRepository` has no SKU or warehouse-code lookup (`phase-03…:134` full list). `getStatus(actor,{sku,warehouseCode})` needs SKU→id and code→id resolution that Phase 03 does not build and `phase-08…:180` explicitly forbids adding ("**không** tạo bề mặt mới ở đây"). Also collides with Finding 1: `inventory` has no org column (`phase-03…:49-59`), so "tự scope org" is undefined for it. |
| 4 | `LedgerService.history` | `phase-03…:24,138` (named, no signature) | `phase-08…:86`, `phase-09…:24,151` (inventory detail ledger timeline) | **MATCH (weak).** No signature, no filter contract. `phase-03…:23` lists ledger filters (inventory/product/warehouse/order/reservation/txn_type) but no date range, while `phase-09…:24` needs a per-inventory chronological timeline and `phase-08…:86` needs per-SKU/warehouse. Index `(inventory_id, created_at desc)` exists (`phase-03…:78`); a product+warehouse filter has no index. |
| 5 | `OrderService.diagnose(actor, orderId)` | `phase-04…:243` | `phase-08…:83,137,180` | **MATCH.** Return shape undefined; `phase-08…:83` requires it to distinguish 3 blocker classes (payment / expired reservation / stock) and `phase-08…:160` tests all 3. Specify the return union in Phase 04. |
| 6 | `ReservationService.listExpiring(actor, withinMinutes)` | `phase-04…:243` | `phase-08…:84,138,180`, `phase-09…:26` (Reservations screen) | **MATCH.** |
| 7 | `OrderService.list` | **nowhere** | `phase-08…:82` (`find_orders` → `OrderService.list`) | **MISMATCH.** Phase 04 declares `GetOrder`/`ListOrders` **use cases** (`phase-04…:242`) and an `OrderService` with exactly two methods (`phase-04…:243`: `diagnose`, `listExpiring`). `OrderService.list` is never declared; `phase-08…:180` reviews only 4 services and does not list it. Phase 08 must either add it (violating its own "không tạo bề mặt mới") or call a use case directly (breaking the uniform tool→service contract at `phase-08…:74`). Compounded by Finding 1: scoped to `actor.orgId`, it returns 0 rows for ops. |
| 8 | `OrderService.markPaid(actor, orderId, paymentId)` | `phase-06…:62`, listed as a **Modify** to Phase 04's file (`phase-06…:97,129`) | `phase-06…:128` only | **MISMATCH (ordering).** Declared 2 phases after the state machine that needs it. Phase 04 tests #4 and #11 (`phase-04…:208,221`) require `paid` and cannot reach it. See Finding 6. |
| 9 | `PriceResolver.resolve` | Two contradictory declarations **in the same file**: `phase-02…:22` — `resolve(actor\|orgId, productId, qty, at)` (single product) vs `phase-02…:64-65` — `resolve(orgId, items[], at): Promise<Map<string, ResolvedPrice>>` (batch) | `phase-04…:73` (`resolve(actor.orgId, items, now)` — matches the batch form); `phase-08…:85` (`get_contract_price` → `PriceResolver.resolve`); `phase-10…:57-65,97` (via `QuoteCartUseCase`) | **MISMATCH ×3.** (a) Intra-file drift, `:22` vs `:64`. (b) **`phase-08…:85` breaks the phase's own security contract**: `phase-08…:28` and `plan.md:97` require every tool to "gọi application service **có guard**" taking `Actor` first — `PriceResolver.resolve` takes `orgId: string` first and has no guard and no `Actor`. Worse, the §Overview use case ("giá hợp đồng của **khách A**", `phase-08…:15`) needs a *customer* org id, which `phase-08…:209` forbids the tool schema from declaring and `phase-08…:152` (test #2) asserts must be ignored — the tool as specified is unanswerable. (c) **`phase-10…:61` requires `minQtyApplied`**, which `ResolvedPrice` (`phase-02…:67-71`: `unitPrice`, `sourceKind`, `sourceId`) does not have; Phase 10's Modify list (`phase-10…:79-82`) does not include `modules/pricing`, so the required contract change is unbudgeted. |
| 10 | `ResolvedPrice` | `phase-02…:67-71` | `phase-04…:81` (`price_list_item_id` ← `sourceId`), `phase-08…:161` (`sourceKind`), `phase-10…:61` (`sourceKind` + `minQtyApplied`) | **MISMATCH** — see 9(c). |
| 11 | `Actor` | `phase-01…:49-54` — `{userId, orgId, orgType, roles}` | `phase-03…:138`; `phase-04…:67,243`; `phase-06…:62`; `phase-08…:61-66,94,99`; `phase-10…:53,80` | **MATCH** on shape (consistent in all 8 sites, never widened — `phase-01…:149` guards this). **But semantically broken** by Findings 1 and 4: `orgId` is singular while `org_members` is many-to-many with no org-switch (Finding 8a), and there is no declared way to carry `Actor` into the request-scoped harness (Finding 4). |
| 12 | `MemoryStore` | `phase-07…:89-95` | `phase-08…:94-97` (`memoryScope`, retrieval/consolidation/adjudicate namespaces), `phase-11…:53` | **MISMATCH (incomplete).** The 5 methods are internally consistent and `search`/`neighbours` correctly take `namespaces: string[]`, matching `phase-08…:95`. **But** `adjudicateAgainst` (`phase-07…:113`, `phase-08…:97`) is a parameter of no declared method on `MemoryStore` or `ConsolidationService`, and Invariant 1 — the one `phase-07…:205` calls "rất khó phát hiện" — is enforced through it. Also `forRoot` (`phase-07…:74-80`) has no namespace/scope parameter, so Phase 08 has no declared way to inject `org:<orgId>` per request. |
| 13 | `ToolDefinition` vs `ToolFactory` | `ToolDefinition`: `phase-07…:77,182` (boot-time, via `forRoot`). `ToolFactory`: `phase-08…:61,181` (per-request, `(actor) => tool`) | `phase-08…:61-68,73,186` | **MISMATCH — confirmed.** Different types, different lifetimes, no adapter declared anywhere. See Finding 4. |
| 14 | `AgentRuntime` / `RunInput` / `RunResult` / `RunEvent` / `AgentDefinition` / `StrategyDefinition` | `phase-07…:102-104` (interface only), `:42-43` (type names only) | `phase-07…:169` (test #9), `phase-08…:135` (`forRoot({agents, strategies, tools, …})`), `phase-08…:172` (SSE tool events), `phase-09…:82,118` | **MISMATCH (undefined).** 5 of 6 types are named and never specified. `RunEvent` in particular must carry `tool_start`/`tool_end` for `phase-08…:172` and `phase-09…:82-87,149`, and nothing verifies the real runtime can produce them (`phase-07…:169` uses a fake; `phase-00…:119,132` spike doesn't cover tool calling). See Finding 4. |
| 15 | `OutboxHandler` | `phase-05…:70-73` | `phase-05…:158` (`AuditLogHandler`), `phase-05…:171` (a second log-only handler in test) | **MATCH** on shape. `OutboxEvent` is referenced (`:72`) but never defined — presumably the `RETURNING *` row shape. |
| 16 | Outbox **row writers vs table owner** | Table created in Phase 04 migration 006 (`phase-04…:157-162`); altered in Phase 05 migration 007 (`phase-05…:101-106`) | Written in `phase-04…:84` (`order.created`), `phase-04…:107` (`order.cancelled`), `phase-06…:23,111` (`payment.succeeded`, `order.paid`) | **Migration order is COHERENT** (006 before 007, sequential). **Column contract is NOT** — dual `processed_at`/`status`, index predicate mismatch, `status` never set to `'processed'`. See Finding 7. |
| 17 | Migration numbering 001–010 | 001 P00 (`phase-00…:84`) · 002 P01 (`:92`) · 003+004 P02 (`phase-02…:119`) · 005 P03 (`phase-03…:102`) · 006 P04 (`phase-04…:182`) · 007 P05 (`phase-05…:124`) · 008 P06 (`phase-06…:90`) · 009 P07 (`phase-07…:139`) · 010 P08 (`phase-08…:128`) | — | **No collisions, no gaps.** Cross-table ALTERs are correctly ordered: `inventory_transactions.order_id/reservation_id` FKs deferred from 005 to 006 (`phase-03…:66,161` → `phase-04…:171-174`) — deliberate and documented. **One latent hazard:** `plan.md:76` and `phase-07…:15` say Phase 07 "chạy xen kẽ được nếu muốn đổi vị", but its migration is numbered **009** and the runner applies files "theo thứ tự tên" (`phase-00…:122`). Reordering Phase 07 earlier either breaks the sequence or requires renumbering. Note this constraint in `plan.md:76`. |
| 18 | ADR numbering 0001–0020 | 0001-0002 P00 (`phase-00…:98`), 0003 P00 (`:119` — **not in the Create list at `:98`**, only in step 1 and criterion `:139`), 0004-0005 P01, 0006-0007 P02, 0008 P03, 0009-0011 P04, 0012-0013 P05, 0014 P06, 0015-0017 P07, 0018-0019 P08, 0020 P09 | `phase-11…:24,128,140` ("đủ 20 bản") | **MATCH.** Verified by extracting all `adr/NNNN-*` references: exactly 20 unique, 0001→0020, no collisions, no gaps. Only nit: add 0003 to `phase-00…:98`'s Create list. |
| 19 | `Success Criteria` checkboxes | 101 total across 12 phase files | — | **Mostly verifiable.** Aspirational / unverifiable-as-written: `phase-03…:147` "rà toàn bộ method" (manual), `phase-01…:139` "rà bằng review + grep signature" (manual, and contradicted by Finding 1), `phase-09…:148` "Cả 7 màn có đủ empty/error/loading state" (no automated check; `phase-09…:141` makes it a manual sweep), `phase-11…:137` "chứng minh bằng `git diff` thật" (ceremony, Finding 10), `phase-11…:140` "không ADR nào mâu thuẫn với code thực tế" (unfalsifiable), `phase-11…:141` "đủ để người khác vận hành mà không hỏi" (no reader exists — solo project). `phase-04…:256` "`order_code` không va chạm khi tạo 10.000 đơn" is verifiable but unbudgeted (a 10k-order test run inside a 4-day phase). |

**Test budget, counted for the record.** 96 numbered specs + 4 Playwright e2e = **100 spec files**:
P00=4, P01=6, P02=8, P03=8, P04=15, P05=9, P06=10, P07=10, P08=15, P09=5+3e2e, P10=5+1e2e, P11=0.
Roughly 85 require testcontainers Postgres (`plan.md:89` — "Không mock DB"), and **6 are true
concurrency tests** (P03#6, P04#1/#3/#13, P05#2/#8), one of which must pass 10 consecutive runs
(`phase-04…:250`). `plan.md:142` already flags testcontainers flakiness on Windows as risk #7 and
budgets **zero days** for it. Phases 03 (2d / 8 specs / full inventory port of the reference repo's
largest module — 1,544 Go LOC, verified), 05 (2d / 9 specs / ~28 artifacts) and 06 (2d / 10 specs /
1,017 Go LOC ported) are the three tightest. My expectation: TDD discipline holds through Phase 02 and
starts eroding in Phase 04 — the phase where it matters most.

---

## Minimum Viable Plan

All 5 chapters (`plan.md:22-28`) delivered, with every cut named.

| Chapter | Delivered by | Changed? |
|---|---|---|
| 1. Concurrency & transaction | **P03, P04** | unchanged, +`mark-paid` endpoint |
| 2. Pricing as policy engine | **P02** | chain collapsed (Finding 5), warehouse folded in (Finding 9) |
| 3. Outbox & eventual consistency | **P05** | single status column (Finding 7), audit = 2 files (Finding 9) |
| 4. Multi-tenant boundary & RBAC | **P01** | scoping table added (Finding 1), `org_members` → `users.org_id` (Finding 8a) |
| 5. Agent over domain tools | **P07, P08** | contract types specified up front (Finding 4) |

**Keep:** P00 (+ extend the spike to cover tool-calling + event streaming — Finding 4), P01, P02, P03,
P04, P05, P07, P08, P09 (reduced), P11 (reduced).

**Cut 1 — Phase 06 (Payment) entirely. −2 days, −10 specs, −~20 files, −1 ADR, −1 migration.**
Rationale from the plan's own chapter table (`plan.md:22-28`): P06 maps to **no** learning chapter.
`phase-06…:152` pre-empts the objection — "Giá trị thật nằm ở idempotency + port + không chồng chéo
aggregate" — but idempotency is already taught by `idempotency_keys` + tests #12/#13 (`phase-04…:222-223`),
the port/adapter pattern is already taught three times (`PriceResolver` `phase-02…:63`; `LlmGateway`,
`AgentRuntime`, `MemoryStore` `phase-07…:102,89`), and aggregate ownership is a 60-line method. Replace
with an ops-only `POST /orders/:id/mark-paid` in **Phase 04** (which Finding 6 shows Phase 04 needs
anyway to make its own tests #4 and #11 runnable). Remove `6` from `phase-09…:6`'s dependency list.
If you later want the payment chapter, it reappears as a clean 2-day v1.1 phase against a stable
state machine — strictly easier than doing it now.

**Cut 2 — Phase 10 (Buyer Portal) entirely, now, not "if late". −3 days, −6 specs, −~30 files,
−1 backend endpoint + use case + contract schema.** `phase-10…:15` already nominates it as first to
cut. It maps to no chapter, and the two things it would demonstrate are already visible in the ops
console: per-org contract pricing is demonstrated by the Price lists screen's resolve box
(`phase-09…:138` — "ô 'thử resolve giá' cho (org, SKU, qty)") and `INSUFFICIENT_STOCK` is proven by
`phase-04…:205` (test #1). It also carries the only unbudgeted `ResolvedPrice` contract change in the
plan (Finding 9c / contract row 10). Deleting it also removes P11's dependency on it (`phase-11…:6`).

**Cut 3 — Phase 09 from 7 screens to 4. −2 days, −~25 files.** Keep exactly the screens that make a
chapter visible: **Inventory + ledger timeline** (ch.1), **Orders + state machine + reservations**
(ch.1/3), **Reservations expiring** (ch.1/3), **Copilot with tool badges** (ch.5). Fold the price-resolve
box onto the Orders screen (ch.2). Cut **Dashboard** (`phase-09…:23` — its 4 tiles are 4 list screens
you already have, and it forces a bespoke `/ops/dashboard` aggregation endpoint, `phase-09…:106`),
**Price lists CRUD** (seed data is enough; `phase-02…:155`) and **Organizations & users CRUD**
(`phase-09…:28` — seed is enough; `phase-01…:128`). Keep `api-client.ts` + the refresh mutex in full —
`phase-09…:78` is a genuine cross-phase lesson and its test #2 is the single highest-value FE test here.

**Cut 4 — Phase 11 hardening only. −1 day.** Keep `verify-architecture.sh` (moved to Phase 00 —
Finding 10), `docs/system-architecture.md`, `docs/decisions-vs-stockflow.md` (`phase-11…:56` — for a
learning project this is the highest-value artifact in the plan, keep it in full), the ADR index, and
the clean-machine quickstart rerun (`phase-11…:122`). Cut `docs/operations.md` (`phase-11…:141` —
"đủ để người khác vận hành mà không hỏi": there is no other person) and cut the git-diff ceremony
(`phase-11…:88`).

**Cut 5 — the in-phase reductions from Findings 5, 8 and 9.** −5 pricing files, −10 warehouse files,
−6 audit files, −1 table, ≈ −1 day.

**Net: 35–37 days → ~24–26 days. −22 test specs (100 → ~78). −~110 files. All 5 chapters intact, and
three of the four Critical contract breaks disappear as a side effect** (Finding 6 is resolved by the
P06 cut moving `markPaid` into P04; Finding 9c by the P10 cut; Finding 5 by the chain collapse).
Findings 1, 2, 3 and 4 must be fixed regardless of scope — they are correctness, not size.

**Sequencing change worth more than any cut:** move the two riskiest unknowns into Phase 00. The
Bedrock spike (`phase-00…:119`) already exists and is the right instinct; extend it to (a) one real
tool call through `StrandsAgentRuntime` with an observable `tool_start`/`tool_end` event, and (b) a
10-line `RunInput`/`RunEvent`/`ToolDefinition` type sketch. Roughly half a day in week 1 that de-risks
7 days in weeks 6–7.

---

## Unresolved Questions

1. **Can an `internal`-org actor read buyer-org data, and under what rule?** Nothing in 13 files
   answers this. Every ops-facing feature (P08 tools, P09 screens) depends on the answer, and
   `plan.md:96` as written says no. Needs a decision before Phase 01 starts.
2. **Does Strands TS v1.10 expose per-tool lifecycle events on its stream?** `phase-08…:172` and the
   entire P09 copilot demo depend on it; nothing in the plan verifies it. Answerable in ~1 hour during
   the Phase 00 spike.
3. **Which org does the JWT carry when a user has ≥2 `org_members` rows?** Undefined
   (`phase-01…:20,51,73-77,125`). Moot if `org_members` is cut.
4. **Is multi-currency in or out?** Four `currency` columns and a throwing `Money.add` exist; no
   exponent table, no FX, no non-VND seed. Pick one — the half-built version is the only bad option.
5. **Does Phase 05's relay/scheduler use `UnitOfWork` or the raw pool?** Not stated
   (`phase-05…:34-46`), and it determines whether the Phase 00 lint boundary can survive at all
   (Finding 3).

---

Status: DONE_WITH_CONCERNS
Summary: Four Critical cross-phase contract breaks (internal-org read path, sweeper/expire-use-case
contradiction, platform↔modules lint rule vs Phase 05, ToolDefinition/ToolFactory + five unspecified
harness types) will each block a phase mid-build; separately the plan is ~40% oversized for its stated
learning goal and can deliver all 5 chapters in ~24–26 days instead of 35–37 by cutting Phases 06 and
10, three ops screens, and the 3-resolver pricing chain.
Concerns: Findings 1–4 are correctness, not scope, and must be resolved before Phase 01 starts —
cutting scope does not fix them. Findings 1 and 4 are cheapest to fix now (a resource-scoping table in
Phase 01; five type definitions plus a 40-line extension to the Phase 00 Bedrock spike) and most
expensive to discover in weeks 6–7.
