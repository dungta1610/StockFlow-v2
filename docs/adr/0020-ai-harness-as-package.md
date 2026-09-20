# 0020 — The AI harness is a package, and it ships no controller

**Status:** accepted · 2026-09-20

## Context
The agent machinery — runtime, tools, memory, sessions — was ported from a standalone
AI-Harness application. That application put one thing in a place a library cannot copy: a
231-line `SessionController` that orchestrated a whole chat turn (replay window, retrieval,
agent call, persistence, consolidation claim) and held its two tuning constants as module
locals.

Porting it verbatim would have produced a package that *looks* complete and quietly is not.
The orchestration would have been dropped on the floor, and with it the rule that makes
memory form after a single turn.

## Decision
`packages/ai-harness` is a library with no HTTP surface.

- **No controller.** A route needs the application's guards — `@Roles`, `OrgScope`, the
  JWT guard — and those are commerce concepts the package must not know. HTTP belongs to
  `apps/api`.
- **`ChatTurnService` is the orchestration.** The five steps the controller used to run are
  a service in the package: store the user turn → replay the window and the running summary
  → recall memory into the system prompt → run the agent → persist the reply and claim a
  consolidation pass. `apps/api` authorises, calls it, and streams the events out.
- **Everything host-specific arrives through `AiHarnessModule.forRoot(config)`**, including
  the `pg` Pool and the schema it writes to. The package reads no environment variable of
  its own: a library that reaches for `process.env` cannot be configured twice in one
  process and cannot be tested without setting global state.
- **`forRoot` validates rather than trusts.** The rules it enforces are the ones whose
  violation is silent — see ADR 0022 for `consolidateAfterMessages`.
- **The package never imports `apps/`.** Enforced by `eslint.config.mjs`, by
  `scripts/verify-architecture.sh`, and by `test/harness/no-domain-import.spec.ts`, which
  scans import *specifiers* rather than source text (a text scan for domain words lights up
  on the first `ORDER BY` in a query and gets switched off the same day).

## Consequences
- The harness can be tested without a network, a credential or a budget: every test binds a
  fake gateway, and `ChatTurnService` is exercised end to end against real Postgres.
- A second application — or a buyer-facing copilot — reuses the package by calling
  `forRoot` with different agents and tools. Nothing is copied.
- `apps/api` owns two things it did not before: the HTTP shape of a chat turn, and the
  translation from an authenticated actor to `RunContext.principal`.
- The chat cadence constants are configuration, not module locals, so they can differ per
  deployment and are validated at boot.
