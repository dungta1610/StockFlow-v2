# 0003 — Bedrock region, models, and tool-event observability

**Status:** accepted, **verification pending** · 2026-09-17

## Context
Every AI phase depends on three facts that cannot be established from documentation:
whether the chat model answers, how many dimensions the embedding model returns (it fixes
`vector(N)` in the `ai` schema), and whether the Strands SDK exposes tool-call lifecycle
events on `agent.stream()` (the reference AI-Harness code only ever saw `textDelta`).

## Decision
- All model access goes through LiteLLM (`config/litellm/config.yaml`), pinned to
  `ghcr.io/berriai/litellm:v1.98.0`. App code uses only the aliases `default-chat` and
  `default-embed`.
- `default-chat` = Claude Haiku 4.5 on Bedrock; `default-embed` = Cohere Embed Multilingual v3.
- Region: **us-east-1** (both models available there).
- Strands SDK: `@strands-agents/sdk` 1.18. Its type definitions declare
  `beforeToolCallEvent` / `afterToolCallEvent`; whether they reach `agent.stream()` is
  exactly what the spike checks.
- The facts are established by `scripts/spike-bedrock.mts` (`pnpm spike:bedrock`) before
  the AI phases start.

## Verification — PENDING
Not yet run: no AWS credentials are configured in this environment (the script exits with
code 2 and says so). To complete:

1. Put `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (or `AWS_BEARER_TOKEN_BEDROCK`) in `.env`.
2. `docker compose up -d litellm`
3. `pnpm spike:bedrock`
4. Record here: (a) chat reply, (b) embedding dimension, (c) the VERDICT line.

| Question | Result |
|---|---|
| (a) chat answers | _pending_ |
| (b) embedding dimension (expected 1024) | _pending_ |
| (c) tool lifecycle events on `agent.stream()` | _pending_ |

## Consequences
- (b) sets `vector(N)` in the ai-harness migration. Changing the embedding model later
  means a column type change **and** re-embedding every row, not only recalibrating score floors.
- (c) decides whether the harness maps SDK events (~0.5 day) or needs its own tool loop
  (~2–3 days, already budgeted).
- If Bedrock is unreachable, point the aliases at another provider in the LiteLLM config;
  the commerce phases do not depend on it.
