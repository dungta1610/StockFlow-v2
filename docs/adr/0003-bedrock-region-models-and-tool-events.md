# 0003 — Bedrock region, models, and tool-event observability

**Status:** accepted; (a) and (b) **verification pending**, (c) **resolved without the spike** · 2026-09-17, revised 2026-09-20

## Context
Every AI phase depends on three facts that cannot be established from documentation:
whether the chat model answers, how many dimensions the embedding model returns (it fixes
`vector(N)` in the `ai` schema), and whether the Strands SDK exposes tool-call lifecycle
events on `agent.stream()` (the reference AI-Harness code only ever saw `textDelta`).

## Decision
- All model access goes through LiteLLM (`config/litellm/config.yaml`), pinned to
  `ghcr.io/berriai/litellm:v1.98.0`. App code uses only the aliases `default-chat` and
  `default-embed`.
- `default-chat` = Claude Haiku 4.5 on Bedrock (`us.anthropic.claude-haiku-4-5-20251001-v1:0`);
  `default-embed` = Cohere Embed Multilingual v3 (`cohere.embed-multilingual-v3`), 1024 dimensions.
- Region: **us-east-1** (both models available there).
- Strands SDK: `@strands-agents/sdk` 1.18. Its type definitions declare
  `beforeToolCallEvent` / `afterToolCallEvent`; whether they reach `agent.stream()` is
  exactly what the spike was to check.
- The facts are established by `scripts/spike-bedrock.mts` (`pnpm spike:bedrock`).

## Embedding calibration
These two numbers belong together and move together:

| | |
|---|---|
| Embedding model | `cohere.embed-multilingual-v3` |
| Dimensions | 1024 — `vector(1024)` in `db/migrations/009_ai_memory.sql` |
| Retrieval score floor | **0.28** |

The floor is measured, not chosen: on this model unrelated questions score 0.17–0.25 and
genuinely relevant ones 0.33–0.52, so the gap sits between them. The scale is compressed and
asymmetric — even an exact restatement reaches only ~0.78, because queries and documents are
embedded with different `input_type` values. That asymmetry is also why
`ai.embedding_cache` keys on `input_type`: without it the cache returns the wrong half of
the pair and every number above stops meaning anything.

**Changing the model behind `default-embed` means:** changing the column type, re-embedding
every stored row, and re-measuring the floor. It is not a config tweak.
`test/harness/score-floor.spec.ts` and
`test/harness/embedding-dimension-matches-migration.spec.ts` fail if one of these facts is
edited without the others.

## Verification

| Question | Result |
|---|---|
| (a) chat answers | _pending_ — no AWS credentials in this environment |
| (b) embedding dimension (expected 1024) | _pending_ — no AWS credentials in this environment |
| (c) tool lifecycle events on `agent.stream()` | **moot** — see below |

To complete (a) and (b): put `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (or
`AWS_BEARER_TOKEN_BEDROCK`) in `.env`, `docker compose up -d litellm`, then
`pnpm spike:bedrock` and record the results above.

### (c) resolved by removing the dependency, not by answering it

The spike could not run, so the harness was built on the branch that does not need the
answer: `OpenAiToolLoopRuntime` runs the tool loop itself against the OpenAI-compatible
protocol LiteLLM serves for every provider behind it. It calls the handlers, so it times
them, so `tool_start` / `tool_end` are facts it observes rather than events it hopes an SDK
will emit.

This was the budgeted fallback (Phase 07, 2–3 days), taken deliberately rather than by
default: the requirement is a *guarantee* that the application can show which tool ran and
for how long, and a guarantee that rests on unverified SDK behaviour is not one. The runtime
sits behind `AgentRuntime`, so a Strands implementation can be added later as a DI binding
if the spike ever shows it would carry the same information — no caller changes.

## Consequences
- (b) sets `vector(N)`. Until the spike runs, 1024 is taken from the model's published
  dimension and asserted against the migration by a test; a live measurement that disagrees
  would mean a column change plus re-embedding.
- The harness needs no Bedrock access to be developed or tested: every test binds a fake
  gateway. Only the end-to-end smoke run does, and it stays outstanding.
- If Bedrock is unreachable, point the aliases at another provider in the LiteLLM config;
  the commerce phases do not depend on it, and neither does anything in
  `packages/ai-harness` except the smoke run.
