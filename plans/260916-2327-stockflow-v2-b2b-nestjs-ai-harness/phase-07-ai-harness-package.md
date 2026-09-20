---
phase: 7
title: "packages/ai-harness Extraction"
status: completed (smoke test outstanding — no AWS credentials)
priority: P1
dependencies: [0]
---

# Phase 07: packages/ai-harness Extraction

> **Viết lại sau red-team (finding #3, #4, #9, #10, #11).** Bản đầu của phase này viết từ README và `system-architecture.md` của AI-Harness chứ không từ TypeScript — nên gần như mọi giả định tích hợp đều sai. Bản này dựa trên chữ ký thật đã đọc. 3→**6 ngày**, và con số đó đã gồm phương án dự phòng nếu Strands không phát tool event.

## Thực tế đã build (2026-09-20)

Xong 15/16 tiêu chí. 16 file test (57 test) xanh trên pgvector thật; toàn suite `apps/api` 480 test xanh; lint, typecheck, build sạch.

| Thiết kế | Đã build | Lý do / nơi ghi |
|---|---|---|
| Bước 1 đọc kết luận spike P00 về tool event | Spike **không chạy được** (máy không có AWS credential). Chọn thẳng nhánh `OpenAiToolLoopRuntime` | ADR 0021: yêu cầu là *bảo đảm*, mà bảo đảm dựa trên hành vi SDK chưa verify thì không phải bảo đảm. Strands thêm sau = một binding DI |
| `strands-agent.runtime.ts` | Không tạo | Cùng lý do trên. `AgentRuntime` là interface; test #15 chứng minh thay được |
| `tools/tool-definition.ts` | `ToolDefinition`/`ToolFactory` nằm trong `config/types.ts` | DRY — chúng là một phần của bộ 5 type đặc tả ở bước 4, tách file riêng chỉ để khớp cây thư mục là trùng lặp |
| RRF hợp nhất trong SQL | Hai nhánh xếp hạng trong SQL, **hợp nhất trong TS** (`memory/rrf.ts`) | Test #3 đòi hàm thuần. Pool mỗi nhánh đã chặn (~20–40 dòng) nên fuse ở TS không tốn gì, và công thức chỉ nằm ở một chỗ. HNSW vẫn nguyên vì bộ lọc namespace vẫn lặp theo nhánh |
| `EmbeddingService` cache LRU trong process | Cache bằng **bảng** `ai.embedding_cache` | Khoá `(content_hash, model, input_type)` theo plan; bảng thì restart không mua lại vector đã trả tiền |
| `ChatTurnService.stream(input: RunInput)` | `stream(input: ChatTurnInput)` = `Omit<RunInput, 'tools' \| 'history' \| 'systemPromptExtra'>` | Ba field bỏ ra chính là thứ service này sinh ra. Nhận `RunInput` đầy đủ rồi ghi đè là chữ ký nói dối |
| — | Thêm `ChatTurnService.settled()` | Pass nền không await được thì test phải `sleep` — flaky theo thiết kế. Shutdown cũng cần nó để không giết pass giữa chừng |
| `db/migrations/009_ai_memory.sql` | Đúng như plan | `vector(1024)`, `chat_sessions` có `tenant_id`/`owner_user_id`, `embedding_cache` có `input_type` trong PK |
| — | Root `pnpm.overrides."@types/pg": "8.23.1"` | Hai workspace package resolve cùng range `^8.15.0` ra hai version khác nhau ⇒ kiểu `Pool` không tương thích qua biên package |
| `.env.example` có `MEMORY_SCORE_FLOOR` | Thay bằng `EMBED_DIMENSIONS`; floor 0.28 nằm cạnh strategy trong `agent.registry.ts` | Không code nào đọc `MEMORY_SCORE_FLOOR` — một env var được tài liệu hoá mà không ai đọc còn tệ hơn không tài liệu. Floor hiệu chuẩn theo model nên phải nằm cạnh thứ dùng nó, và ADR 0003 giữ cặp (model, floor) |

**Còn treo:** bước 14 (smoke test agent `math` qua Bedrock thật) và hai tiêu chí spike (a)(b) của ADR 0003 — đều chờ AWS credential. Mọi test khác chạy trên gateway giả nên không phụ thuộc.

## Overview

Port AI-Harness thành thư viện **không biết gì về thương mại**. Không phải copy-paste: phase này bổ sung ba thứ bản gốc **không có** và Phase 08–09 bắt buộc phải có — tool lifecycle event trên stream, chủ sở hữu cho phiên chat, và tool dựng theo từng request.

## Bản gốc thật sự là gì — đọc trước khi làm

Bốn sự thật đã kiểm chứng trong `AI-Harness-Clone/apps/api/src`, khác với mô tả trong tài liệu của chính repo đó:

| Sự thật | Bằng chứng | Hệ quả |
|---|---|---|
| `streamAgent` là `AsyncGenerator<string>`, **chỉ** yield `delta.type === 'textDelta'`; event union được chính code gọi là "opaque here" | `agent/agent.service.ts` ~dòng 130–146 | **Không có** `tool_start`/`tool_end`. Phải tự xây |
| `REPLAY_WINDOW = 8` và `CONSOLIDATE_AFTER_MESSAGES = 2` là **hằng cấp module trong `session.controller.ts`** (dòng 29, 40); controller cũng gọi `claimConsolidation` và `summaries.refresh` | `session/session.controller.ts:29,40,205,214` | Orchestration một lượt chat nằm trong controller. Package không ship controller ⇒ **Invariant 2 không có nhà** |
| `ToolRegistry` hardcode `[getTimeTool, calculatorTool]` trong Map, typed `StrandsTool = ReturnType<typeof tool>` | `tools/tool.registry.ts` | Tool là **boot-time và Strands-coupled**. Phase 08 cần per-request |
| `AgentConfig.memory.scope` là **string tĩnh** | `agent/agent.config.ts` | Phase 08 cần `org:<orgId>` theo từng request ⇒ scope phải là hàm |

Và chữ ký `MemoryStore` thật — bản plan trước tôi viết sai hoàn toàn:

```ts
// THẬT (AI-Harness-Clone/apps/api/src/memory/memory-store.interface.ts)
export interface MemoryStore {
  upsert(write: MemoryWrite): Promise<MemoryRecord>          // namespace nằm TRONG write
  search(namespaces: string | string[], query: string, options?: SearchOptions): Promise<MemoryRecord[]>
  neighbours(namespaces: string | string[], content: string, limit?: number): Promise<MemoryRecord[]>
  supersede(ids: number[]): Promise<number>                  // KHÔNG có namespace ← lỗ hổng thật
  list(namespace: string, limit?: number): Promise<MemoryRecord[]>
}
// MemoryRecord.id là number (BIGSERIAL), không phải string
```

**"Đổi namespace từ tuỳ chọn thành bắt buộc" là tiền đề sai** — nó vốn đã bắt buộc ở `upsert`/`search`/`list`. Lỗ hổng thật chỉ nằm ở **`supersede(ids)`**, cái duy nhất ghi xuyên nhiều row, và nó chạy trên id do LLM chọn ra từ `neighbours`. Đó là chỗ phải vá, và vá bằng **mệnh đề `WHERE`**, không phải bằng tham số.

## Requirements

**Functional**
- Package export: `AgentRuntime`, `ChatTurnService`, `ToolRegistry`, `MemoryStore`, `LlmGateway`, `RetrievalService`, `ConsolidationService`, `SessionService`, `SessionSummaryService`.
- `AiHarnessModule.forRoot(config)` — mọi thứ đặc thù ứng dụng đi vào qua đây, **gồm cả DB**.
- **`ChatTurnService`** — một lượt chat trọn vẹn: replay → retrieval → agent → persist → claim consolidation. *(Bản gốc để việc này trong controller.)*
- **Tool lifecycle event** trên `AgentRuntime.stream()`.
- **Per-request tool + per-request memory scope.**
- `chat_sessions` có **chủ sở hữu và tenant**.
- Cache embedding theo `(content_hash, model, input_type)`.

**Non-functional**
- `packages/ai-harness` **không** import `apps/api` (ESLint + test).
- Package **không ship controller** — HTTP là việc của `apps/api` vì route cần guard từ Phase 01.
- Mọi truy vấn `MemoryStore` có mệnh đề namespace, **kể cả `supersede`**.

## Architecture

```
packages/ai-harness/src/
├── index.ts
├── ai-harness.module.ts          # forRoot(config)
├── config/
│   ├── harness-config.ts         # AgentDefinition · StrategyDefinition · db · llm
│   └── types.ts                  # RunInput · RunResult · RunEvent · RunContext
├── runtime/
│   ├── agent-runtime.interface.ts
│   ├── strands-agent.runtime.ts        # mặc định
│   ├── openai-tool-loop.runtime.ts     # dự phòng — CHỈ viết nếu spike P00 nói cần
│   └── agent.service.ts
├── chat/
│   └── chat-turn.service.ts      # ← MỚI: orchestration một lượt
├── tools/
│   ├── tool-definition.ts        # ToolDefinition · ToolFactory
│   ├── tool.registry.ts          # nhận factory, dựng instance theo request
│   └── builtin/{calculator,get-time}.tool.ts
├── llm/{llm-gateway.interface.ts, litellm.gateway.ts, llm.types.ts}
├── memory/
│   ├── memory-store.interface.ts # chữ ký THẬT + supersede có namespace
│   ├── pgvector-memory.store.ts
│   ├── embedding.service.ts      # + cache (content_hash, model, input_type)
│   ├── retrieval.service.ts
│   ├── consolidation.service.ts
│   └── text-similarity.ts
└── session/{session.service.ts, session-summary.service.ts}
```

### Năm type mà bản plan trước đặt tên nhưng không đặc tả (sửa finding #11)

```ts
export interface RunContext {
  sessionId: string
  /** Định danh tenant đục lỗ qua package — package KHÔNG hiểu nghĩa của nó. */
  principal: { id: string; tenantId: string }
}

export interface RunInput {
  agentName: string
  input: string
  context: RunContext
  history?: ChatMessage[]
  tools: ToolDefinition[]        // dựng theo request, không lấy từ registry tĩnh
  systemPromptExtra?: string     // nơi retrieval chèn memory
}

export interface RunResult { text: string; toolCalls: ToolCallRecord[]; usage?: TokenUsage }

export type RunEvent =
  | { type: 'text';       delta: string }
  | { type: 'tool_start'; callId: string; name: string; input: unknown }
  | { type: 'tool_end';   callId: string; name: string; ok: boolean; durationMs: number }
  | { type: 'error';      message: string }

export interface AgentDefinition {
  name: string
  systemPrompt: string
  model: string
  toolNames: string[]
  memory?: {
    /** HÀM, không phải string — Phase 08 cần org:<orgId> theo request. */
    scope: (ctx: RunContext) => string
    strategies?: string[]
  }
}

export interface StrategyDefinition {
  name: string; extractionPrompt: string; topK: number; minScore: number
}
```

`RunContext.principal.tenantId` là cách tenant đi xuyên package mà package **không** cần biết "org" là gì. `apps/api` truyền `actor.orgId` vào; harness chỉ dùng nó để dựng namespace và gán chủ sở hữu.

### `forRoot` — có slot DB (sửa finding #10)

```ts
AiHarnessModule.forRoot({
  db: { pool: Pool, schema: 'ai' },     // ← bản trước thiếu, mà 3 class inject DatabaseService
  llm: { baseUrl, apiKey, chatModel, embedModel, embedDimensions },
  agents: AgentDefinition[],
  strategies: StrategyDefinition[],
  tools: ToolFactory[],
  chat: { replayWindow: number, consolidateAfterMessages: number },  // ← hằng ra khỏi controller
  memoryStore?: Provider,               // mặc định PgVectorMemoryStore
})
```

`chat.consolidateAfterMessages` **không được vượt 2** — đặt cao hơn thì hội thoại ngắn không bao giờ hình thành memory. Đó là bug bản gốc đã sửa; validate bằng zod lúc `forRoot`, không phải bằng ghi chú.

### `ChatTurnService` — nhà cho Invariant 2 (sửa finding #10)

Bản gốc để orchestration trong `SessionController` 231 dòng. Package không ship controller, nên nếu port y nguyên thì phần điều phối **biến mất** và test cho Invariant 2 kiểm một thứ không tồn tại.

```ts
class ChatTurnService {
  /** Một lượt: replay → retrieval → agent → persist → (nền) consolidate */
  async *stream(input: RunInput): AsyncIterable<RunEvent>
  async run(input: RunInput): Promise<RunResult>
}
```
Bên trong, đúng thứ tự bản gốc:
1. `sessions.getMessages(sessionId, replayWindow)` + running summary cho phần cũ hơn.
2. `retrieval.recall(namespaces, input)` → chèn vào `systemPromptExtra`.
3. `runtime.stream(...)` → phát `RunEvent` ra ngoài.
4. Lưu lượt vào `chat_messages`.
5. **Sau khi reply đã gửi**, nền: `sessions.claimConsolidation(sessionId, consolidateAfterMessages)` → nếu claim được thì `summaries.refresh` + `consolidation.consolidate` với **toàn bộ transcript** (`getMessages(sessionId)` **không giới hạn** — đó chính là lý do "pass lỗi thì memory muộn chứ không mất"; bản plan trước bỏ sót chi tiết này).

### Hai invariant phải port nguyên vẹn

**Invariant 1 — adjudicate phải phủ mọi namespace mà retrieval đọc.** Consolidation *ghi* vào `<scope>:<strategy>` nhưng *xét* candidate trên `[<scope>, <scope>:<strategy>]`. Thiếu scope trần ⇒ row ghi thẳng qua API không bao giờ bị supersede ⇒ vĩnh viễn được recall như sự thật. Quy tắc: **thêm namespace vào đường đọc thì phải thêm vào `adjudicateAgainst`.** *(Đã verify tồn tại ở `memory/consolidation.service.ts`.)*

**Invariant 2 — gate bằng marker tiến, không bằng tổng số message.** `chat_sessions.consolidated_through` giữ id message mới nhất đã vào một pass; gate hỏi *"bao nhiêu message mới"*, không hỏi *"tổng có chia hết cho N"* — một tổng số có thể không bao giờ chạm mốc. Marker tiến **trước** khi pass chạy: pass lỗi không bị thử lại mỗi lượt, và vì pass sau đọc lại **toàn bộ** transcript nên memory muộn chứ không mất.

### Ba lỗ hổng phải vá khi port

**1. `supersede` không có namespace (finding #9).** Vá bằng `WHERE`, không phải bằng tham số:
```ts
supersede(namespaces: string[], ids: number[]): Promise<number>
// UPDATE memories SET superseded_at = now()
//  WHERE id = ANY($2::bigint[]) AND namespace = ANY($1)   ← mệnh đề mới là thứ enforce
```
Quy tắc ghi vào `code-standards.md`: **mọi statement trong `MemoryStore` chứa `namespace = ANY($ns)`.** Test hợp đồng chạy trên **mọi** method, không chỉ `search`.

**2. `chat_sessions` không có chủ (finding #3).** Bản gốc đúng 4 cột. Thêm:
```sql
ALTER TABLE ai.chat_sessions
  ADD COLUMN tenant_id      uuid NOT NULL,
  ADD COLUMN owner_user_id  uuid NOT NULL;
CREATE INDEX ON ai.chat_sessions (tenant_id, updated_at DESC);
```
`SessionService` nhận `{tenantId, ownerUserId}` **bắt buộc** trên mọi method đọc/ghi. Không có nó, `GET /copilot/sessions/:id` chỉ guard bằng role, và role không phải tenancy.

**3. Tool là boot-time và Strands-coupled (finding #11).**
```ts
export interface ToolDefinition<I = unknown> {
  name: string; description: string
  schema: ZodType<I>
  handler: (input: I) => Promise<unknown>
}
export type ToolFactory = (ctx: RunContext) => ToolDefinition
```
`ToolRegistry.build(names, ctx)` dựng instance **cho từng request** từ factory. `ToolDefinition` là type **của ta**, không phải `ReturnType<typeof tool>` của Strands — adapter sang Strands nằm trong `strands-agent.runtime.ts`. Đó là điều kiện để runtime thay được thật.

### Tool lifecycle event — việc thật, có giờ (sửa finding #4)

Phase 00 spike đã trả lời: Strands có phát event quan sát được hay không.

- **Có** ⇒ map event thô sang `RunEvent` trong `strands-agent.runtime.ts` (~0.5 ngày).
- **Không** ⇒ viết `openai-tool-loop.runtime.ts`: zod→JSON-schema, giao thức message assistant/tool, vòng lặp nhiều lượt có chặn, ghép delta tool-call khi stream, xử lý lỗi (**2–3 ngày, đã tính trong 6 ngày của phase này**).

Cách nào cũng phải bọc handler để đo `durationMs` và phát `tool_start`/`tool_end` — phần đó ta tự làm, không phụ thuộc SDK.

### Schema (migration `009_ai_memory.sql`, schema `ai`)

Port 5 file từ `AI-Harness-Clone/db/init/`, đưa vào schema `ai`, **cộng ba thay đổi**:
- `ai.chat_sessions` thêm `tenant_id`, `owner_user_id` (NOT NULL).
- `ai.embedding_cache(content_hash text, model text, input_type text, embedding vector(N), created_at, primary key (content_hash, model, input_type))` — **`input_type` nằm trong khoá**: model embedding bất đối xứng, cùng một chuỗi embed dạng `search_document` khác dạng `search_query`; bỏ nó ra khỏi khoá thì cache trả **vector sai** một cách im lặng và floor 0.28 mất ý nghĩa.
- `vector(N)` với **N = số chiều đo được ở Phase 00 spike**, không phải hằng chép tay. Đổi model embedding = đổi kiểu cột + re-embed toàn bộ, không phải "đo lại floor" — ghi vào ADR.

### Score floor

Bản gốc hiệu chuẩn 0.28 cho Cohere Embed Multilingual v3 (không liên quan 0.17–0.25; liên quan 0.33–0.52; giống hệt chỉ ~0.78 vì query và document embed khác `input_type`). Spike Phase 00 xác nhận đúng model ⇒ giữ 0.28. Đổi model ⇒ **đo lại và re-embed**. Test #6 biến việc này thành gate.

## Related Code Files

**Create**
- `db/migrations/009_ai_memory.sql`
- `packages/ai-harness/src/**` (cấu trúc ở §Architecture)
- `packages/ai-harness/{package.json,tsconfig.json}`
- `docs/adr/0020-ai-harness-as-package.md`
- `docs/adr/0021-agent-runtime-behind-interface.md`
- `docs/adr/0022-memory-namespace-and-session-ownership.md`

**Modify**
- `config/litellm/config.yaml` — hoàn thiện alias (đã spike ở Phase 00)
- `.env.example` — `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `REPLAY_WINDOW`, `CONSOLIDATE_AFTER_MESSAGES`, `MEMORY_SCORE_FLOOR`
- `docs/code-standards.md` — rule "mọi statement `MemoryStore` có mệnh đề namespace"

**Reference (read-only) — đọc CODE, không đọc README**
- `AI-Harness-Clone/apps/api/src/memory/memory-store.interface.ts` — chữ ký thật
- `AI-Harness-Clone/apps/api/src/memory/pgvector-memory.store.ts` — đặc biệt `supersede`
- `AI-Harness-Clone/apps/api/src/memory/consolidation.service.ts` — `adjudicateAgainst` (Invariant 1)
- `AI-Harness-Clone/apps/api/src/memory/{retrieval.service.ts,embedding.service.ts,strategy.config.ts,text-similarity.ts}`
- `AI-Harness-Clone/apps/api/src/session/{session.service.ts,session-summary.service.ts}`
- **`AI-Harness-Clone/apps/api/src/session/session.controller.ts`** — 231 dòng orchestration + hằng dòng 29, 40; nguồn cho `ChatTurnService`
- `AI-Harness-Clone/apps/api/src/agent/{agent.service.ts,agent.config.ts}` — `streamAgent` ~130–146
- `AI-Harness-Clone/apps/api/src/{tools/tool.registry.ts,llm/llm.service.ts}`
- `AI-Harness-Clone/db/init/00{1..5}_*.sql`

## Tests First (TDD — nghiêm)

1. **`harness/memory-store-contract.spec.ts`** — bộ test hợp đồng chạy trên pgvector thật cho **mọi** method: upsert → search thấy; supersede → không search thấy nhưng **row vẫn còn** (giữ để audit).
2. **`harness/namespace-isolation-all-methods.spec.ts`** — `search`, `list`, `neighbours` **và `supersede`** đều không chạm namespace khác. *(Riêng `supersede` là đường ghi xuyên row, chạy trên id do LLM chọn — bản gốc để hở.)*
3. `harness/rrf-fusion.spec.ts` — hàm thuần: thứ tự RRF đúng công thức; tài liệu ở cả hai nhánh được đẩy lên.
4. `harness/lexical-diacritics.spec.ts` — lưu "Khánh thích cà phê đen", query "Khanh" ⇒ nhánh lexical khớp.
5. `harness/score-floor.spec.ts` — bộ câu hỏi đã gán nhãn ⇒ floor hiện tại phân tách đúng. **Fail nếu đổi embedding model mà chưa đo lại.**
6. **`harness/embedding-dimension-matches-migration.spec.ts`** — số chiều gateway trả về **khớp** `vector(N)` trong migration 009.
7. `harness/consolidation-invariant-1.spec.ts` — fact ghi qua `upsert` vào scope trần; consolidation với fact mâu thuẫn ⇒ row scope trần **bị supersede**.
8. `harness/consolidation-invariant-2.spec.ts` — hội thoại **đúng 1 lượt** ⇒ consolidation **có** chạy. Pass lỗi ⇒ marker vẫn tiến, không thử lại vô hạn, và **pass sau đọc lại toàn bộ transcript** nên nội dung không mất.
9. **`harness/forroot-validates-cadence.spec.ts`** — `consolidateAfterMessages > 2` ⇒ `forRoot` ném lỗi lúc boot.
10. **`harness/embedding-cache.spec.ts`** — cùng chuỗi + cùng model + cùng `input_type` ⇒ gateway gọi 1 lần. **Cùng chuỗi, khác `input_type` ⇒ cache MISS và hai vector khác nhau.**
11. **`harness/tool-events.spec.ts`** — `stream()` phát `tool_start` rồi `tool_end` đúng thứ tự, có `callId` khớp, `durationMs` > 0, và `ok=false` khi handler ném.
12. **`harness/per-request-tools.spec.ts`** — hai `RunContext` khác nhau ⇒ hai bộ tool instance khác nhau; handler nhận đúng ctx của mình; không rò state giữa hai request.
13. **`harness/per-request-memory-scope.spec.ts`** — `AgentDefinition.memory.scope(ctx)` cho hai tenant ⇒ hai namespace khác nhau; retrieval và consolidation đều dùng namespace đã resolve.
14. **`harness/session-ownership.spec.ts`** — `SessionService.get` với `tenantId` khác ⇒ không trả về. Không method nào cho đọc session mà thiếu tenant.
15. `harness/runtime-swappable.spec.ts` — bind `AgentRuntime` bằng fake ⇒ `ChatTurnService` chạy trọn vẹn, chỉ đổi DI binding.
16. **`harness/no-domain-import.spec.ts`** — quét package: không import nào trỏ `apps/`. Quét **import specifier**, không quét văn bản nguồn (bản trước định grep từ khoá `order`, mà các file ported có 11 mệnh đề `ORDER BY` — sẽ đỏ ngay ngày đầu).

## Implementation Steps

1. **Đọc lại kết luận spike Phase 00** về tool event — nó quyết định bước 10 tốn 0.5 hay 3 ngày.
2. Migration `009_ai_memory.sql`: port 5 file, `vector(N)` theo số đo spike, `chat_sessions` thêm `tenant_id`/`owner_user_id`, `embedding_cache` có `input_type` trong PK.
3. Viết 16 test ở §Tests First — đỏ.
4. `config/types.ts` — đặc tả đủ 5 type ở §Architecture **trước** khi viết implementation nào.
5. Port `llm/` → `LlmGateway` + `LiteLlmGateway`. Cấu hình qua `forRoot`, **không** đọc `process.env` trong package.
6. Port `memory-store.interface.ts` với chữ ký **thật** + `supersede(namespaces, ids)`. Port `pgvector-memory.store.ts`, thêm mệnh đề namespace vào **mọi** statement. Test #1, #2 xanh.
7. Port `text-similarity.ts` + RRF; tách phần hợp nhất thành hàm thuần. Test #3, #4, #5 xanh.
8. `embedding.service.ts` + cache theo `(hash, model, input_type)`. Test #6, #10 xanh.
9. Port `consolidation.service.ts` — **đọc `adjudicateAgainst` của bản gốc trước khi viết** (Invariant 1). Port `session.service.ts` + `session-summary.service.ts`, `SessionService` nhận tenant/owner. Test #7, #14 xanh.
10. `runtime/`: `AgentRuntime` interface, `StrandsAgentRuntime` (hoặc `OpenAiToolLoopRuntime` theo kết luận bước 1), bọc handler để phát `tool_start`/`tool_end` + đo thời gian. Test #11, #15 xanh.
11. `tools/`: `ToolDefinition`/`ToolFactory` (type của ta), `ToolRegistry.build(names, ctx)`. Giữ `calculator` + `get_time` làm builtin. Test #12 xanh.
12. **`chat/chat-turn.service.ts`** — 5 bước ở §Architecture. Test #8, #13 xanh.
13. `AiHarnessModule.forRoot()` + validate zod (gồm `consolidateAfterMessages <= 2`) + `index.ts` export tối thiểu. Test #9, #16 xanh.
14. Smoke test end-to-end: agent `math` (chỉ `calculator`) chạy qua Bedrock thật, **và stream phát tool event**.
15. ADR 0020, 0021, 0022.

## Success Criteria

- [ ] 16 test ở §Tests First xanh.
- [ ] Smoke test: agent `math` trả lời đúng `15 * 23` qua Bedrock thật, SSE có **cả text lẫn `tool_start`/`tool_end`**.
- [ ] `grep -rn "apps/" packages/ai-harness/src/` ⇒ rỗng; ESLint cũng chặn.
- [ ] **Mọi** statement trong `MemoryStore` có mệnh đề namespace — rà thủ công từng câu SQL và ghi vào PR note.
- [ ] Không method nào của `SessionService` cho đọc session mà thiếu `tenantId`.
- [ ] Hai request khác tenant ⇒ tool instance và memory namespace khác nhau.
- [ ] `forRoot({consolidateAfterMessages: 3})` ⇒ ném lỗi lúc boot.
- [ ] Cùng nội dung khác `input_type` ⇒ cache miss.
- [ ] Số chiều embedding đo được khớp `vector(N)` trong migration.
- [ ] Hội thoại 1 lượt vẫn hình thành memory (Invariant 2 không bị port sai).
- [ ] Fact ghi thẳng qua `upsert` ở scope trần **bị** supersede khi có fact mâu thuẫn (Invariant 1 không bị port sai).
- [ ] Thay `AgentRuntime` bằng fake ⇒ `ChatTurnService` vẫn chạy.
- [ ] ADR 0020–0022 tồn tại; 0022 nêu rõ "namespace được enforce bằng mệnh đề `WHERE`, không phải bằng tham số".

## Risk Assessment

| Rủi ro | Giảm thiểu |
|---|---|
| **Strands không phát tool event** | Spike Phase 00 trả lời ở **ngày 1**, không phải tuần 6. Fallback `OpenAiToolLoopRuntime` đã có 2–3 ngày trong ngân sách phase này — không còn là "bảo hiểm miễn phí" như bản trước tuyên bố |
| **Port sót Invariant 1** ⇒ memory sai âm thầm, rất khó phát hiện | Test #7 là gate cứng; bước 9 bắt buộc đọc `adjudicateAgainst` bản gốc trước |
| **Port sai Invariant 2** | Test #8 dùng đúng kịch bản 1 lượt mà bản gốc từng bug, **và** assert pass sau đọc lại toàn bộ transcript |
| `supersede` vẫn ghi xuyên tenant sau khi port | Test #2 phủ **mọi** method; rà thủ công từng câu SQL là success criterion |
| Package leak khái niệm thương mại | Test #16 quét **import specifier** (không quét văn bản — `ORDER BY` sẽ false-positive) + ESLint |
| Chi phí Bedrock khi chạy test | Gateway giả cho mọi test trừ smoke ở bước 14; cache embedding; LiteLLM virtual key budget |
| Port thành "copy rồi sửa dần" ⇒ kéo theo coupling cũ | Ba lỗ hổng ở §Ba lỗ hổng phải vá **trong lúc** port, không phải sau. Đặc tả 5 type ở bước 4 **trước** mọi implementation |
| 6 ngày vẫn thiếu | Nếu `OpenAiToolLoopRuntime` phải viết **và** vượt 3 ngày: dừng, cắt `get_time` khỏi builtin, và cân nhắc bỏ streaming ở v1 (copilot trả JSON, Phase 09 bỏ badge tool). Ghi lại quyết định thay vì âm thầm trễ |
