# Red-Team Plan Review — Assumption Destroyer (Scope Auditor, Full tier)

Reviewer: code-reviewer (hostile lens)
Date: 2026-09-17
Target: `plans/260916-2327-stockflow-v2-b2b-nestjs-ai-harness/` (13 files, 2264 lines)
Evidence: plan files; `StockFlow/StockFlow` (Go, read-only); `AI Harness Clone/AI-Harness-Clone` (TS, read-only)

Verdict: the plan's *domain* reasoning about the Go repo is accurate and verifiable. Its reasoning about the
AI-Harness repo is largely **written from the README and the architecture doc, not from the code**. Every
Phase 07/08/09 integration assumption I tested against the actual TypeScript failed. Two invariants the plan
claims to protect (tenant isolation, reservation release) are broken by the plan's own text.

---

## Finding 1: Sweeper marks reservations `releasing`, expire only releases `held` — stock is never returned

- **Severity:** Critical
- **Location:** Phase 05, "Reservation expiry job"; Phase 04, "Luồng huỷ / hết hạn"
- **Flaw:** Two phases define the same lifecycle with incompatible state filters. Phase 05's job claims rows by
  flipping them to `releasing` **in its own statement**, then calls `ExpireOrderUseCase`. Phase 04's expire flow
  iterates "cho từng reservation **status='held'** của đơn". After the claim, zero rows match `held`. The order
  flips to `expired`; `available_qty` is never incremented; `reserved_qty` is never decremented; no `release`
  ledger row is written.
  Worse, the claim is `LIMIT $batch`, so a multi-line order can be **partially** claimed. Even after fixing the
  `held`/`releasing` filter, the first `ExpireOrderUseCase` call sets the order to `expired`, and the
  idempotency guard ("status đã là cancelled/expired ⇒ trả về nguyên trạng, KHÔNG lỗi") makes the remaining
  `held` rows permanently unreachable. Stock leaks and never comes back without manual SQL.
- **Failure scenario:** Order with 3 lines expires. Sweep batch size 2 claims lines 1–2. `ExpireOrderUseCase`
  finds no `held` rows, marks the order `expired`, commits. Line 3 stays `held` forever; its units stay in
  `reserved_qty` forever. `available + reserved` is still conserved, so Phase 04 test #4 never catches it.
  Phase 05 test #8 (2 sweepers / 50 reservations, asserts "no double-count") passes trivially because nothing
  is released at all.
- **Evidence:**
  - `phase-05-outbox-relay-scheduler.md:84` — `UPDATE inventory_reservations SET status='releasing'`
  - `phase-05-outbox-relay-scheduler.md:87` — `ORDER BY id LIMIT $batch FOR UPDATE SKIP LOCKED`
  - `phase-05-outbox-relay-scheduler.md:90` — `→ với mỗi order: gọi ExpireOrderUseCase (đã idempotent từ Phase 04)`
  - `phase-04-ordering-atomic-reservation.md:102` — `cho từng reservation status='held' của đơn (ORDER BY product_id)`
  - `phase-04-ordering-atomic-reservation.md:100` — idempotency guard that makes the orphan permanent
  - `phase-04-ordering-atomic-reservation.md:149` — `status in ('held','releasing','released','consumed')`
- **Suggested fix:** Put the release in exactly one place. Either (a) the job claims by `order_id`, claiming
  *all* of an order's expired reservations or none, and `ExpireOrderUseCase` releases
  `status IN ('held','releasing')`; or (b) drop `releasing` entirely and let `ExpireOrderUseCase`'s
  `SELECT orders … FOR UPDATE` be the concurrency gate, with the job supplying only candidate `order_id`s.
  Add a test: order with N lines, batch size N−1, assert `available_qty` fully restored.

---

## Finding 2: Copilot chat sessions have no tenant column and no tenant scoping — acceptance criteria #4 is not met

- **Severity:** Critical
- **Location:** Phase 07, "Schema (migration `009_ai_memory.sql`)" + non-functional #3; Phase 08, "Tests First"
- **Flaw:** Phase 07 makes `namespace` mandatory on `MemoryStore` **only**. Sessions are excluded. The source
  `chat_sessions` table has exactly four columns — `id, agent_name, created_at, updated_at` — no namespace, no
  org, no user. `SessionService.findById` and `SessionService.list` take no scope argument and emit unfiltered
  SQL. Phase 07's migration 009 ports these tables as-is and adds no org column. Phase 08 exposes
  `GET /copilot/sessions` and `GET /copilot/sessions/:id` straight onto them.
- **Failure scenario:** An `ops` user in org B obtains a session UUID from org A (a log line, an error payload,
  a shared link) and calls `GET /copilot/sessions/<id>`. `findById` has no org predicate; org A's full
  operations transcript — inventory levels, order codes, contract prices — is returned.
  `@Roles('ops','ops_admin')` passes, because the user *is* ops; role is not tenancy. This defeats plan.md
  acceptance criteria #4 ("không đọc được … memory của org B qua bất kỳ endpoint nào, kể cả copilot") and
  Phase 08 has **no test for it**: tests #2 and #3 cover tools and memory namespaces only.
- **Evidence:**
  - `phase-07-ai-harness-package.md:30` — namespace mandatory, scoped to `MemoryStore` only
  - `phase-07-ai-harness-package.md:131` — `003_sessions` → `ai.chat_sessions`, `ai.chat_messages` (no org column added)
  - `AI-Harness-Clone/db/init/003_sessions.sql:2-7` — `chat_sessions(id, agent_name, created_at, updated_at)`
  - `AI-Harness-Clone/apps/api/src/session/session.service.ts:83-104` — `findById(sessionId)`, `WHERE id = $1`, no scope
  - `AI-Harness-Clone/apps/api/src/session/session.service.ts:56-72` — `list(limit)`, no scope
  - `phase-08-ops-copilot.md:22` — `GET /copilot/sessions`, `GET /copilot/sessions/:id` exposed
  - `phase-08-ops-copilot.md:152-153` — tests #2/#3 cover tools and memory, not sessions
  - `plan.md:96` — acceptance criteria #4
- **Suggested fix:** Add `namespace text not null` (or `org_id uuid not null`) to `ai.chat_sessions` in
  migration 009; make it a required parameter on `SessionService.create/list/findById/getMessages/
  claimConsolidation`; add Phase 08 test: `actor(orgB).getSession(orgA_session_id) ⇒ 404`.

---

## Finding 3: The agent stream emits text only — `tool_start`/`tool_end` do not exist and nobody budgeted building them

- **Severity:** Critical
- **Location:** Phase 07 Requirements ("Streaming SSE của agent loop"); Phase 08 Requirements + test #13; Phase 09 "Copilot UI"
- **Flaw:** `AgentService.streamAgent` structurally narrows every Strands event and yields **only**
  `delta.type === 'textDelta'`. Everything else is dropped. The source repo documents this as a known,
  load-bearing limitation — it is the stated reason episodic memory was not shipped. Phase 07 lists
  "Streaming SSE của agent loop" as if it were a straight port; Phase 08 asserts SSE emits `tool_start`/
  `tool_end` "đủ cho UI Phase 09"; Phase 09's most-demoed feature ("Badge tool là chi tiết khiến copilot đáng
  tin") consumes them. No phase has a step, a file, or an hour allocated to surfacing tool events out of the
  Strands event union — a union the existing code calls "opaque here" and handles by structural guesswork.
- **Failure scenario:** Phase 08 is "done", tests 1–12 green, then test #13 cannot be made green without
  reverse-engineering `@strands-agents/sdk` v1.10's undocumented streaming event shapes. Phase 09 starts on
  schedule, reaches step 12 (Copilot UI), and finds the badge feature has no data source — on day 5 of 6.
- **Evidence:**
  - `AI-Harness-Clone/apps/api/src/agent/agent.service.ts:134-145` — `if (delta?.type === 'textDelta' && delta.text) yield delta.text;`
  - `AI-Harness-Clone/apps/api/src/agent/agent.service.ts:135-137` — "Types inside the event union are opaque here, so narrow structurally"
  - `AI-Harness-Clone/apps/api/src/memory/strategy.config.ts:99-105` — "AgentService filters the agent stream down to text deltas, so tool calls never reach the transcript… To add it: surface tool events on the stream first"
  - `AI-Harness-Clone/apps/api/src/session/session.controller.ts:176` — SSE frame is `{delta}` only
  - `phase-07-ai-harness-package.md:24` — "Streaming SSE của agent loop" (no tool events)
  - `phase-08-ops-copilot.md:25`, `phase-08-ops-copilot.md:172` — requires `tool_start`/`tool_end`
  - `phase-09-web-ops-console.md:82-87` — UI depends on them
- **Suggested fix:** Make "surface tool lifecycle events on `AgentRuntime.stream()`" an explicit first-class
  step in Phase 07 with its own test (agent calls `calculator` ⇒ stream yields `tool_start{name}` then
  `tool_end{name,ok}`), and add 1–2 days. This is also the prerequisite for the episodic strategy the source
  repo deliberately deferred — worth stating.

---

## Finding 4: Phase 07 extracts services but leaves orchestration in a controller it refuses to ship, and `forRoot` cannot reach the database

- **Severity:** Critical
- **Location:** Phase 07, Requirements (non-functional), "Ba thay đổi thực chất", Implementation step 8
- **Flaw:** Four compounding gaps.
  1. **The orchestration lives in the controller.** `SessionController` is 231 lines and is where the turn
     actually happens: replay window, SSE framing, persisting the assistant reply, and — critically — the
     `claimConsolidation` call and the entire background maintenance pass. `REPLAY_WINDOW` and
     `CONSOLIDATE_AFTER_MESSAGES` are module constants *in that controller*. Phase 07 says the package ships no
     controller and lists only `SessionService` + `SessionSummaryService` to port. Invariant 2 — which the plan
     calls out by name and gates with test #7 — therefore has **no home in the package**. Test #7
     ("hội thoại đúng 1 lượt ⇒ consolidation có chạy") would test a component the plan never creates, or
     `apps/api` reimplements 231 lines of orchestration in `modules/copilot` — exactly the parallel
     reimplementation the phase exists to prevent.
  2. **`forRoot` has no database slot.** `PgVectorMemoryStore`, `SessionService`, and `SessionSummaryService`
     all inject `DatabaseService` from `apps/api/src/database`. The plan's config object is
     `{agents, strategies, tools, memoryStore, llm}` — no pool, no connection string, no `Tx`/`UnitOfWork`
     handle. As specified, the package cannot connect to Postgres.
  3. **The `MemoryStore` interface in the plan is not a port of the real one.** Plan:
     `upsert(namespace, entry): Promise<string>`, `supersede(namespace, ids: string[])`,
     `neighbours(namespaces, vector: number[], k)`. Actual: `upsert(write: MemoryWrite): Promise<MemoryRecord>`
     (namespace already **required** inside `MemoryWrite`), `supersede(ids: number[]): Promise<number>`,
     `neighbours(namespaces, content: string, limit)`. IDs are `BIGSERIAL`/`number`, not strings. `neighbours`
     taking a **vector** instead of **content** moves embedding responsibility to the caller and rewrites the
     consolidation flow. And the phase's stated premise — "namespace từ tuỳ chọn thành bắt buộc" — is false for
     `upsert`/`search`/`list`, where it is already required. The only method genuinely missing a namespace is
     `supersede`.
  4. **Config contradiction:** step 3 says "Cấu hình qua `forRoot`, không đọc env trực tiếp trong package", but
     the Modify list adds `REPLAY_WINDOW`, `CONSOLIDATE_AFTER_MESSAGES`, `MEMORY_SCORE_FLOOR` to `.env.example`,
     and `forRoot` has no slot for any of them.
- **Failure scenario:** Day 3 of a 3-day phase, the developer finds the package exports services that cannot be
  composed into a working turn, and must invent a `ChatTurnService` (new abstraction, no domain anchor,
  mid-phase) while also threading a DB handle through `forRoot`. Phase 08 then depends on whatever shape that
  improvised service took.
- **Evidence:**
  - `AI-Harness-Clone/apps/api/src/session/session.controller.ts:29` (`REPLAY_WINDOW = 8`), `:40` (`CONSOLIDATE_AFTER_MESSAGES = 2`), `:202-230` (`scheduleMaintenance`), `:205` (`claimConsolidation` call site), `:154-192` (SSE + persistence)
  - `phase-07-ai-harness-package.md:29` — "Package **không ship controller/route**"
  - `phase-07-ai-harness-package.md:181` — step 8 ports only the two session services
  - `phase-07-ai-harness-package.md:167` — test #7 depends on the controller-resident gate
  - `phase-07-ai-harness-package.md:74-80` — `forRoot` config shape, no DB
  - `AI-Harness-Clone/apps/api/src/memory/pgvector-memory.store.ts:98`, `session/session.service.ts:28`, `session/session-summary.service.ts:27` — all inject `DatabaseService`
  - `AI-Harness-Clone/apps/api/src/memory/memory-store.interface.ts:161-168, 193-230` — real interface
  - `phase-07-ai-harness-package.md:88-96` — plan's invented interface
  - `phase-07-ai-harness-package.md:176` vs `:148` — env contradiction
- **Suggested fix:** Add a `ChatTurnService` (or `SessionRunner`) to the package's export list and architecture
  tree, owning replay/stream/persist/consolidate, with `replayWindow` and `consolidateAfterMessages` as
  `forRoot` config. Add `db` (pool or `UnitOfWork`) to the `forRoot` contract. Rewrite the `MemoryStore` block
  to match real signatures, and restate change #2 honestly: "add namespace to `supersede`; close the bare-scope
  read path" rather than "make namespace mandatory".

---

## Finding 5: "Resolve N products = 1 query" is incompatible with the three-resolver chain, and Phase 04 was built on the claim

- **Severity:** High
- **Location:** Phase 02, Non-functional #3, "Chain of resolvers", Implementation step 7, test #7
- **Flaw:** The chain is `ContractPriceResolver → DefaultListResolver → BasePriceResolver`. The first two read
  `price_list_items ⋈ price_lists`. The third reads `products.base_price` — a different table, and the
  repository method the plan defines (`findApplicable(orgId, productIds, at)`) covers price lists only. A cart
  containing any product absent from every price list needs a second query. Test #7 asserts the executed query
  count is **exactly 1** with a spy on the pool. Either the test fails, or the implementer collapses all three
  resolvers into one SQL statement — which destroys the phase's headline property ("Thêm khuyến mãi / giá chiến
  dịch sau này = thêm một resolver vào chain") and Phase 11's indicator #4 that verifies it by `git diff`.
- **Failure scenario:** Test #7 written red, resolver chain implemented, test stays red. Under deadline the
  implementer writes a single `LEFT JOIN LATERAL` over `products` + `price_list_items`, deletes the three
  resolver classes, and the "policy engine" chapter — one of the five the project exists to teach — is gone.
  Or test #7 is weakened to "≤ 3" and nothing catches a real N+1 in Phase 04's in-transaction call.
- **Evidence:**
  - `phase-02-catalog-warehouse-pricing.md:178` — "tốn **một query**, không phải N query"
  - `phase-02-catalog-warehouse-pricing.md:223` — chain of three resolvers
  - `phase-02-catalog-warehouse-pricing.md:220` — `sourceKind: … | 'base_price'`, `sourceId: null`
  - `phase-02-catalog-warehouse-pricing.md:231-235` — `base_price` lives on `products`, not on any price-list table
  - `phase-02-catalog-warehouse-pricing.md:302` — `findApplicable(orgId, productIds, at)` covers price lists only
  - `phase-02-catalog-warehouse-pricing.md:291` — test #7 asserts "= 1"
  - `phase-04-ordering-atomic-reservation.md:75-77` — `priceResolver.resolve(...) ← MỘT query` inside the order transaction
  - `phase-11-docs-diagrams-hardening.md:85` — indicator #4 depends on the chain surviving
- **Suggested fix:** Restate the invariant as **"O(1) round-trips, bounded and independent of cart size"** and
  set test #7 to assert `queryCount <= 2` *and* `queryCount(3 items) === queryCount(20 items)`. Keep the chain.
  Also state whether `price_lists.status='active'` participates in selection — the schema has the column, the
  selection rule at `phase-02:264` never mentions it.

---

## Finding 6: Phase 08 depends on a Redis rate limiter that Phase 00 never builds, and no phase builds a Redis client at all

- **Severity:** High
- **Location:** Phase 08, "Reference (read-only)" + Implementation step 11; Phase 00, "Related Code Files"
- **Flaw:** Phase 08 cites the Go limiter annotated "**Redis limiter đã port ở Phase 00**", and step 11 says
  "Rate limit riêng cho copilot (Redis limiter port từ Phase 00)". Phase 00 contains no such deliverable: its
  `platform/` tree is `config, database, errors, observability, validation, health`, and its Create list has no
  rate-limit file, no Redis client, no Redis module. The only Redis presence in Phase 00 is
  `component/redis/redis.go` as a *reference* and `redis:7` in docker-compose. Phase 00 test #4 nevertheless
  asserts `/health` reports Redis liveness — which also requires a Redis client absent from the file list.
  The Go limiter keys on **client IP + path**, not user or org, so even a faithful port does not satisfy
  Phase 08's `COPILOT_RATE_LIMIT_PER_MIN` semantics (a per-user Bedrock spend budget).
- **Failure scenario:** Phase 08 step 11 starts, finds nothing to reuse, and writes a limiter from scratch
  mid-phase (unbudgeted) — or silently uses an in-memory counter, which is wrong the moment more than one API
  instance runs, the exact scenario Phase 05 designs for.
- **Evidence:**
  - `phase-08-ops-copilot.md:145` — "Redis limiter **đã port ở Phase 00**"
  - `phase-08-ops-copilot.md:188` — step 11 consumes it
  - `phase-00-foundation-and-bedrock-spike.md:38-43` — `platform/` subtree: no ratelimit, no redis
  - `phase-00-foundation-and-bedrock-spike.md:80-98` — Create list: no Redis client, no limiter
  - `phase-00-foundation-and-bedrock-spike.md:115` — test #4 asserts Redis health
  - `StockFlow/component/ratelimit/limiter.go:11-13` — `IsAllowed(ctx, clientID, path, limit, window)`
  - `StockFlow/middleware/ratelimit.go:18-21` — `clientID := c.ClientIP()`
- **Suggested fix:** Add `platform/redis/{redis.module.ts,redis.client.ts}` and `platform/ratelimit/` to
  Phase 00's Create list (+0.5 day), or move the limiter into Phase 08 and add the time there. State explicitly
  that the copilot limiter keys on `actor.userId`/`actor.orgId`, not IP — it is a budget control, not an abuse
  control.

---

## Finding 7: The `AgentRuntime` escape hatch is unproven — test #9 proves DI wiring, not that the fallback is writable

- **Severity:** High
- **Location:** Phase 07, "3. `AgentRuntime` sau interface", test #9, Risk Assessment row 1; plan.md risk #1
- **Flaw:** The plan states test #9 proves replaceability "**ngay tại phase này**, không phải hy vọng suông".
  It does not. Binding a *fake* runtime and asserting the flow still runs proves the DI token is injectable —
  true by construction. It says nothing about whether `OpenAiToolLoopRuntime` can be written in the budgeted
  time. The real Strands coupling is wider than "one class behind an interface":
  - `ToolRegistry` is typed `StrandsTool = ReturnType<typeof tool>` — the *tool objects themselves* come from
    the Strands SDK. Phase 07's `ToolDefinition {name, description, schema: ZodType, handler}` requires a new
    adapter in **both** directions (ToolDefinition → Strands tool, and ToolDefinition → raw OpenAI `tools[]`
    JSON-schema).
  - `LlmService.createChatModel` returns `OpenAIModel` from `@strands-agents/sdk/models/openai`; the plan's
    `LlmGateway` interface must absorb that.
  - History is converted to Strands `MessageData` blocks; the reply is dug out of an opaque
    `lastMessage.content` block array with a structural fallback that JSON-stringifies on shape change.
  A real `OpenAiToolLoopRuntime` needs zod→JSON-schema tool serialisation, the assistant/tool message protocol,
  a bounded multi-turn loop, streaming delta assembly *plus* tool-call delta assembly (Finding 3), and error
  handling. Days of work, listed as a mitigation with zero allocated time.
- **Failure scenario:** Strands v1.10 blocks tool streaming (likely, per Finding 3). The "insurance" is invoked.
  It is not insurance; it is a second implementation of the agent loop, discovered at the worst moment, with
  Phase 08 blocked behind it.
- **Evidence:**
  - `phase-07-ai-harness-package.md:107` — "Test #9 chứng minh việc thay thế này khả thi ngay tại phase này, không phải hy vọng suông"
  - `phase-07-ai-harness-package.md:169` — test #9 binds "một fake runtime"
  - `AI-Harness-Clone/apps/api/src/tools/tool.registry.ts:6-7` — `export type StrandsTool = ReturnType<typeof tool>`
  - `AI-Harness-Clone/apps/api/src/llm/llm.service.ts:3,29-37` — returns `OpenAIModel` from the Strands SDK
  - `AI-Harness-Clone/apps/api/src/agent/agent.service.ts:170-184` — `MessageData` conversion + `new Agent({...})`
  - `AI-Harness-Clone/apps/api/src/agent/agent.service.ts:226-238` — opaque result unwrapping
- **Suggested fix:** Either (a) timebox a genuine spike — implement `OpenAiToolLoopRuntime` far enough to pass
  one real tool call against LiteLLM during Phase 00, where the AI risk already lives — or (b) demote the
  fallback from "mitigation" to "known unmitigated risk, cost 2–3 days if triggered" in plan.md risk #1. Do not
  let test #9 stand as evidence of feasibility.

---

## Finding 8: `embedding_cache` keyed on (content_hash, model) is wrong — it ignores `input_type`, and test #8 already passes without the table

- **Severity:** High
- **Location:** Phase 07, "Schema … **Thêm mới**", Requirements ("Cache embedding theo hash nội dung (mới)"), test #8
- **Flaw:** The embedding model is asymmetric: the *same text* embeds differently depending on whether it is a
  `search_document` or a `search_query`, and the existing code documents that sending one input type for both
  "measurably weakens retrieval". The plan's cache key is `(content_hash, model)` with no purpose/input_type
  column. A string embedded once as a query and later stored as a document — or the trivially common reverse:
  "Khánh thích cà phê đen" is stored as a document, then someone searches the identical string — returns the
  **wrong vector** from cache. Nothing fails loudly; retrieval quality silently degrades, and the 0.28 floor,
  calibrated on the query→document scale, stops meaning what test #5 assumes.
  Separately, the feature is labelled "(mới)" but a bounded LRU with exactly this purpose already exists.
  Test #8 ("embed cùng chuỗi 2 lần ⇒ gateway chỉ bị gọi 1 lần") is satisfied by the *existing in-memory LRU*,
  so it proves nothing about the new table — a phantom test for the feature it is attached to.
- **Failure scenario:** Tests #4 and #5 go green in isolation. In Phase 08 the copilot starts recalling
  near-misses and missing exact matches, intermittently, depending on which purpose populated the cache first.
  Close to undebuggable without knowing the asymmetry exists.
- **Evidence:**
  - `phase-07-ai-harness-package.md:134` — `ai.embedding_cache(content_hash text pk, model text, embedding vector(1024), created_at)`
  - `phase-07-ai-harness-package.md:25` — "Cache embedding theo hash nội dung (**mới** — kiểm soát chi phí)"
  - `phase-07-ai-harness-package.md:168` — test #8
  - `AI-Harness-Clone/apps/api/src/memory/embedding.service.ts:10-21` — asymmetry, `INPUT_TYPE` map, "Sending one input type for both halves measurably weakens retrieval"
  - `AI-Harness-Clone/apps/api/src/memory/embedding.service.ts:23-24,39,46-58` — existing bounded LRU, key is `` `${purpose} ${text}` ``
  - `phase-07-ai-harness-package.md:121` — floor calibrated on the query→document scale
- **Suggested fix:** Primary key `(content_hash, model, input_type)`. Extend test #8: "same content, different
  purpose ⇒ cache miss, two gateway calls, two distinct vectors". Restate the feature as "promote the existing
  in-process LRU to a shared persistent cache" so its true scope is visible.

---

## Finding 9: Estimates are fantasy at the top and bottom of the plan, and the Bedrock blast radius is understated by ~15 days

- **Severity:** High
- **Location:** plan.md "Phases" table + risk #2; Phase 00 Implementation Steps; Phase 09; Phase 11
- **Flaw:** The arithmetic is correct (2+3+3+2+4+2+2+3+3+6+3+2 = 35; 3+3+3+2+4+2+2+3+4+6+3+2 = 37). The inputs
  are not.
  - **Phase 00 = 2–3 days** for: Bedrock/LiteLLM spike, pnpm workspace + tsconfig + eslint + prettier, a
    5-service docker-compose with healthchecks and condition-based `depends_on`, a migration runner, error
    envelope + filter + request-id + logging interceptor + zod pipe, config module with fail-fast validation,
    pool + UnitOfWork, health endpoint, a testcontainers harness, a Vite+React+Tailwind+shadcn scaffold, two
    package scaffolds, `code-standards.md`, and three ADRs — plus, per Finding 6, a Redis client the list
    forgot. That is a week.
  - **Phase 09 = 6 days** for 7 screens *plus* an api-client with refresh mutex, an SSE client, an 8-state SVG
    state machine, streaming chat with tool badges and inline approval cards, Playwright setup + 3 e2e specs, a
    design-token/primitive pass, a dedicated empty/error/loading pass across 7 screens, CORS + docker-compose
    changes, the `packages/contracts` export surface — **and a new backend aggregate endpoint `/ops/dashboard`**
    counted inside a frontend budget. Unstated entirely: form handling library, table/pagination component,
    date/timezone handling for `expires_at` countdowns, and the fact that `apps/web` was only ever scaffolded as
    "một trang trắng" in Phase 00. ~7 hours per screen including all of the above.
  - **Phase 11 = 2 days** for: an `EXPLAIN` pass over every filtered list query, an error-code consistency
    audit, a rate-limit audit, dead-code removal, a verify script, two experimental branches with `git diff`
    evidence, a full `down -v` clean rebuild, re-verification of 8 acceptance criteria, 4 diagrams, and 4
    documents including `operations.md` "đủ để người khác vận hành mà không hỏi", plus review of 20 ADRs against
    reality. 16 hours.
  - **Bedrock blast radius:** the mitigation says a failure blocks "chỉ Phase 07–08". The dependency graph says
    07 → 08 → 09 → 10 → 11. A Bedrock failure blocks **17–19 of 35–37 days** — half the project. Also unstated:
    `vector(1024)` is hard-coded in migration 009 and the 0.28 floor is calibrated to one specific embedding
    model. If the region forces a different embedding model with different dimensions, the fix is a **column
    type change plus a full re-embed**, not "đo lại floor".
- **Failure scenario:** The schedule is presented as 7 weeks; the first phase alone overruns by 2–3 days and the
  pattern compounds. Worse, the Bedrock mitigation reads as low-impact, so an amber spike result gets waved
  through — and the real cost lands in Phase 07, exactly where risk #2 promised it would not.
- **Evidence:**
  - `plan.md:41-54` — phases table, "Tổng ≈ 35–37 ngày"
  - `plan.md:66-73` — dependency chain 07→08→09→10→11
  - `plan.md:141` / `phase-00-foundation-and-bedrock-spike.md:145` — "chỉ Phase 07–08 bị chặn"
  - `phase-00-foundation-and-bedrock-spike.md:80-98`, `:117-129` — Phase 00 scope
  - `phase-09-web-ops-console.md:106` — backend dashboard endpoint inside the FE phase
  - `phase-09-web-ops-console.md:127-143` — 14 implementation steps in 6 days
  - `phase-11-docs-diagrams-hardening.md:112-129`, `:131-141` — Phase 11 scope in 2 days
  - `phase-07-ai-harness-package.md:130` — `embedding vector(1024)` hard-coded
  - `phase-07-ai-harness-package.md:121-123` — floor tied to one model
- **Suggested fix:** Re-baseline 00 → 4–5d, 07 → 5–6d (Findings 3, 4, 7), 09 → 8–9d, 11 → 3–4d; new total
  ≈ 45–50 days. Rewrite risk #2's impact line to name all five blocked phases. Add to Phase 00 success criteria:
  "embedding dimension recorded in ADR 0003 **and** referenced by migration 009", so a dimension change is a
  visible schema decision rather than a surprise.

---

## Finding 10: Unstated tooling assumptions — shared-package build, Vitest parallelism vs. a shared truncated database, and cross-phase migration numbering

- **Severity:** Medium
- **Location:** Phase 00, Implementation step 8 + Risk Assessment; plan.md:76; all phase migration filenames
- **Flaw:** Three assumptions asserted as "will work" with no supporting detail anywhere in 2264 lines.
  1. **`packages/contracts` and `packages/ai-harness`.** Step 8 is "Scaffold … rỗng, wire vào workspace +
     tsconfig paths". A grep across all 13 plan files returns **zero** hits for ESM, CJS, `tsup`, build output,
     tsconfig project references, `emitDecoratorMetadata`, `reflect-metadata`, or zod version pinning. But
     `apps/api` is NestJS (CommonJS + decorator metadata + `reflect-metadata`), `apps/web` is Vite (ESM,
     esbuild — which strips types and does **not** emit decorator metadata), `packages/ai-harness` ships Nest
     `@Injectable()`/`@Module()` decorators, and `packages/contracts` must be consumed by both. Whether the
     packages are consumed as source (Vite must be told to transpile a workspace dependency; Nest must resolve
     the path alias at runtime, not only at type-check) or as build artifacts (needs a build step, a watch
     mode, and `exports` maps) is the highest-friction decision in the monorepo, and it is not made. Two zod
     versions across the workspace silently break `z.infer` compatibility at the type level.
  2. **Test harness concurrency.** Phase 00 mitigates testcontainers flakiness with "một container dùng chung
     cho cả suite, **truncate giữa test**". Vitest runs test *files* in parallel by default. A shared database
     plus truncation between tests means concurrently-running files destroy each other's fixtures — and the
     symptom is precisely the flakiness the mitigation exists to prevent, on the very tests (Phase 04 #1,
     Phase 03 #6) whose whole purpose is proving a concurrency invariant. No `vitest.config` pool or
     `fileParallelism` setting appears anywhere; nor does the interaction between Phase 04's "Pool ≥ 60
     connection" and a container Postgres's default `max_connections`. On Windows specifically, nothing is said
     about the Ryuk reaper, the Docker socket path, or the fact that docker-compose already binds the Postgres
     port.
  3. **Migration numbering vs. phase reordering.** plan.md states Phase 07 is independent and resequenceable.
     But migration filenames are hard-coded across phases (001 → 010) and the runner orders "theo thứ tự tên".
     Running Phase 07 early creates `009_ai_memory.sql` before 002–008 exist; later-added lower-numbered files
     then apply *after* a higher-numbered one, so applied order diverges from filename order permanently. The
     reorderability claim is unbacked.
- **Failure scenario:** (1) Phase 09 day 1: `import { orderSchema } from '@stockflow/contracts'` type-checks in
  the IDE, fails at Vite dev-server runtime or Nest boot, and the fix becomes a monorepo build-system decision
  made under schedule pressure. (2) Phase 04 test #1 is run 10× as required and fails 2× — and the team cannot
  distinguish "my atomic UPDATE is wrong" from "another test file truncated my inventory", which is exactly the
  loss of confidence the phase's own risk table names. (3) Someone takes plan.md at its word, runs 07 second,
  and the migration sequence is permanently inconsistent with a clean rebuild — breaking acceptance criteria #8.
- **Evidence:**
  - `phase-00-foundation-and-bedrock-spike.md:126` — "Scaffold … wire vào workspace + tsconfig paths" (the entire treatment)
  - `phase-00-foundation-and-bedrock-spike.md:48-49`, `:95` — contracts + ai-harness + Vite web
  - grep across `plans/260916-2327-*/*.md`: 0 hits for `ESM`, `CJS`, `tsup`, `emitDecorator`, `reflect-metadata`, `peerDep`, `vitest.config`, `fileParallelism`, `singleThread`, `maxWorkers`, `max_connections`
  - `phase-00-foundation-and-bedrock-spike.md:146` — "một container dùng chung cho cả suite, truncate giữa test"
  - `phase-04-ordering-atomic-reservation.md` Risk row 1 — "Pool ≥ 60 connection"
  - `plan.md:76` — "Phase 07 độc lập với nhánh commerce ⇒ chạy xen kẽ được nếu muốn đổi vị"
  - `phase-00-foundation-and-bedrock-spike.md:122` — runner "đọc file theo thứ tự tên"
  - `phase-07-ai-harness-package.md:139` — `db/migrations/009_ai_memory.sql` while `dependencies: [0]`
  - `plan.md:100` — acceptance criteria #8 (clean rebuild)
- **Suggested fix:** Add an explicit Phase 00 decision + ADR: packages consumed as **source** via tsconfig paths
  + Vite `resolve.alias`; zod pinned to one version at the workspace root; `packages/ai-harness` declares
  `@nestjs/common` and `zod` as peer dependencies. Add `vitest.config.ts` (with `poolOptions.threads.singleThread`,
  or one schema per worker via `TEST_SCHEMA`) to Phase 00's Create list and state the isolation strategy. Either
  drop the "Phase 07 is reorderable" claim or switch to timestamp-prefixed migration filenames.

---

## Reference Path Audit

Every "Reference (read-only)" bullet across all 13 plan files, verified against the two repos.

| Phase:line | Cited path | Status | Note |
|---|---|---|---|
| 00:101 | `AI-Harness-Clone/apps/api/src/common/errors/all-exceptions.filter.ts` | EXISTS | 117 lines |
| 00:102 | `AI-Harness-Clone/apps/api/src/common/observability/logging.interceptor.ts` | EXISTS | 48 lines |
| 00:103 | `AI-Harness-Clone/apps/api/src/common/pipes/zod-validation.pipe.ts` | EXISTS | 28 lines |
| 00:104 | `AI-Harness-Clone/apps/api/src/config/env.schema.ts` | EXISTS | 36 lines |
| 00:105 | `AI-Harness-Clone/config/litellm/config.yaml` | EXISTS | |
| 00:105 | `AI-Harness-Clone/docker-compose.yml` | EXISTS | |
| 00:106 | `StockFlow/docker-compose.yml` | EXISTS | |
| 00:106 | `StockFlow/component/redis/redis.go` | EXISTS | but no phase creates a Redis client — Finding 6 |
| 01:104 | `StockFlow/module/user/model/user.go` | EXISTS | `Filter.Normalize()` at `user.go:96-104` confirmed (trim + lowercase email) |
| 01:104 | `StockFlow/module/user/biz/*.go` | EXISTS | create/get/list/update |
| 01:104 | `StockFlow/module/user/storage/sql_user.go` | EXISTS | |
| 01:104 | `StockFlow/module/user/transport/gin/*.go` | EXISTS | 5 files |
| 02:129 | `StockFlow/module/product/{model,biz,storage,transport/gin}` | EXISTS | **but** no `update_product.go` biz and no update handler; `ProductUpdate` model exists unused. Phase 02 Requirements lists "Product: … update" as a port |
| 02:130 | `StockFlow/module/warehouse/{model,biz,storage}` | EXISTS | same: no update biz/handler, yet Phase 02 lists "Warehouse: … update" |
| 02:131 | `StockFlow/module/*/model/paging.go` | EXISTS | present in all 6 modules |
| 03:113 | `StockFlow/module/inventory/model/{inventory.go,inventory_transaction.go,errors.go}` | EXISTS | |
| 03:114 | `StockFlow/module/inventory/storage/{sql_inventory.go,sql_inventory_transaction.go}` | EXISTS | `sql_inventory_reservation.go` also exists and is uncited in Phase 03 |
| 03:115 | `StockFlow/module/inventory/biz/{adjust_stock,get_inventory,list_inventory_transactions}.go` | EXISTS | |
| 04:196 | `StockFlow/module/order/storage/sql_order_tx.go` | EXISTS | `CreateOrder:13`, `CancelOrder:132`, `ExpireOrder:219`, `generateOrderCode:302`. The claim that `CreateOrder` never touches inventory is **verified** (only `reservation_expires_at` matches) |
| 04:197 | `StockFlow/module/order/model/{order.go,order_item.go,errors.go}` | EXISTS | |
| 04:198 | `StockFlow/module/order/biz/*.go` | EXISTS | 5 files |
| 04:199 | `StockFlow/module/inventory/model/inventory_reservation.go` | EXISTS | |
| 05:137 | `AI-Harness-Clone/apps/api/src/session/session.service.ts` | EXISTS | claim marker at `:121-139` confirmed |
| 05:138 | `AI-Harness-Clone/docs/system-architecture.md` §"Invariant 2 — gate bằng marker tiến" | EXISTS | heading at line 124 |
| 06:102 | `StockFlow/module/payment/model/payment.go` | EXISTS | |
| 06:103 | `StockFlow/module/payment/storage/{sql_payment.go,sql_payment_tx.go}` | EXISTS | |
| 06:104 | `StockFlow/module/payment/biz/{checkout_payment.go,callback_payment.go}` | EXISTS | |
| 07:152 | `AI-Harness-Clone/apps/api/src/memory/*` | EXISTS | 9 files; `consolidation.service.ts` (343), `retrieval.service.ts` (132); `adjudicateAgainst` at `consolidation.service.ts:162` confirmed |
| 07:153 | `AI-Harness-Clone/apps/api/src/memory/strategy.config.ts` | EXISTS | floors + calibration note at `:21-33` |
| 07:154 | `AI-Harness-Clone/apps/api/src/session/{session.service.ts,session-summary.service.ts}` | EXISTS | **materially incomplete**: `session.controller.ts` (231 lines) holds the orchestration and is not cited — Finding 4 |
| 07:155 | `AI-Harness-Clone/apps/api/src/{agent,llm,tools}/*` | EXISTS | agent 4 files, llm 3, tools 3 |
| 07:156 | `AI-Harness-Clone/db/init/00{1..5}_*.sql` | EXISTS | all 5 present |
| 07:157 | `AI-Harness-Clone/docs/system-architecture.md` §"Đường ghi long-term memory" | EXISTS | heading at line 71 |
| 08:143 | `AI-Harness-Clone/apps/api/src/agent/agent.config.ts` | EXISTS | 55 lines |
| 08:144 | `AI-Harness-Clone/apps/api/src/tools/builtin/calculator.tool.ts` | EXISTS | 32 lines |
| 08:145 | `StockFlow/component/ratelimit/limiter.go`, `StockFlow/middleware/ratelimit.go` | EXISTS | **annotation false**: "đã port ở Phase 00" — Phase 00 ports nothing. Also IP+path keyed, not user/org — Finding 6 |
| 09:109 | `AI-Harness-Clone/apps/web/src/api/sse.ts` | EXISTS | |
| 09:110 | `AI-Harness-Clone/apps/web/src/components/{message-list.tsx,composer.tsx}` | EXISTS | |
| 10 | — | N/A | Phase 10 has no Reference section |
| 11 | — | N/A | Phase 11 has no Reference section |

**Result: 0 missing paths, 1 false annotation (08:145), 1 materially incomplete citation (07:154).**
The plan's file-level references are accurate. Its *behavioural* claims about those files are where it breaks
down — see Findings 3, 4, 7, 8.

---

## Secondary observations (not counted among the 10)

- **Phase 07 test #10** (`no-domain-import.spec.ts`) proposes scanning the package for the keyword `order`. The
  files being ported contain 11 `ORDER BY` clauses (`pgvector-memory.store.ts` ×5, `session.service.ts` ×4,
  `session-summary.service.ts` ×2). Scoped to import specifiers, the test duplicates the ESLint rule the plan
  already has; scoped to source text, it fails immediately. Narrow it to import specifiers and drop `order`.
- **Phase 02 currency is unvalidated.** `products.currency`, `price_lists.currency`, and `orders.currency` exist
  independently; `Money.add` throws on mismatch (`phase-02:206`); no phase validates that a resolved price's
  currency matches the product's, or that a cart is single-currency. No test in Phase 02 or 04 covers it. A
  mixed-currency cart throws an unmapped domain error mid-transaction.
- **Phase 04/05 outbox has two sources of truth for "processed".** Migration 006 creates `processed_at` plus a
  partial index `where processed_at is null` (`phase-04:164`). Migration 007 adds `status … default 'pending'`
  plus a second partial index `where status = 'pending'` (`phase-05:101-106`). The described success path sets
  only `processed_at = now()` (`phase-05:64`), never `status='processed'`, and the claim query filters on
  `processed_at`, not `status` (`phase-05:57`) — so the new index is never used by the query it was added for,
  and it grows without bound as processed rows retain `status='pending'`.
- **Phase 01 `citext` is correctly handled.** Phase 01 step 1 enables it in migration 002 (`phase-01:119`), so
  the "Phase 00 only creates `vector`" concern does not hold. Noting it as checked.
- **Seed data chain is coherent but fragile.** Phase 01 step 10 (orgs + users) → Phase 02 step 10 (20 SKUs +
  3 price lists) → Phase 03 (`scripts/seed.ts` inventory) → Phase 10 Modify ("ensure 2 buyer orgs differ").
  Phase 08 step 12's demo quality depends on all four. The open question at `plan.md:148` defers the *scale*
  decision to Phase 01 while Phase 02 already fixes it at 20 SKUs — the question is effectively already answered
  and should be closed rather than left open.
- **`ck` CLI absence:** no plan content depends on CLI-managed state. Frontmatter (`status`, `dependencies`,
  `blockedBy`) is hand-maintainable. The only exposure is drift between `plan.md:41-54`'s status column and the
  per-phase frontmatter — a manual-discipline issue, not a structural one.

## Unresolved questions for the planner

1. Who owns the chat turn after extraction — a new `ChatTurnService` inside `packages/ai-harness`, or
   `modules/copilot`? Finding 4 blocks Phase 07 test #7 either way until this is answered.
2. Is the Strands tool-event stream (Finding 3) a Phase 07 deliverable or a Phase 08 one? Whichever it is, it
   needs a named step and hours.
3. Do `/catalog/quote` (Phase 10) and `POST /orders` (Phase 04) accept mixed-currency carts, or is
   single-currency-per-org an invariant? This changes the `price_lists` selection rule.
4. Phase 07's memory scope is per-agent static (`AgentConfig.memory.scope`), but Phase 08 needs it per-request
   (`org:<orgId>`). Neither phase describes how a per-request scope reaches `AgentService.memoryPlan()` or
   `ConsolidationService`. What is the intended mechanism — a scope argument threaded through the runtime, or a
   request-scoped provider?
