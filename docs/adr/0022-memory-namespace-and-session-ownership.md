# 0022 — Memory namespaces and session ownership are enforced by WHERE clauses

**Status:** accepted · 2026-09-20

## Context
Three boundaries in the ported harness were described but not enforced.

1. **`supersede(ids)` took no namespace.** It is the only write that spans rows the caller
   was not handed, and it runs on ids a model picked out of a neighbour lookup. A model
   naming a row from another tenant would have been obeyed.
2. **`chat_sessions` had four columns and no owner.** Holding a session id was the same as
   being allowed to read the transcript.
3. **The memory scope was a static string** on the agent definition, so every tenant would
   have shared one namespace.

Each of these is a leak with no endpoint to blame and no error to notice.

## Decision

**The clause is the enforcement, not the parameter.**

```sql
UPDATE ai.memories SET superseded_at = now()
 WHERE id = ANY($2::bigint[]) AND namespace = ANY($1::text[]) AND superseded_at IS NULL
```

The signature is `supersede(namespaces, ids)`, but a signature only describes an intention.
What refuses a foreign id is `namespace = ANY($1)`.

**The rule, for every implementation of `MemoryStore`:** every statement that reads or
rewrites existing rows carries `namespace = ANY(...)`. An `INSERT` supplies the namespace
instead — there is no prior row for a clause to protect. Both halves are asserted by
`test/harness/namespace-isolation-all-methods.spec.ts`, which scans the SQL itself, and the
behavioural half is checked on `search`, `list`, `neighbours` **and** `supersede`.

**Sessions carry a tenant and an owner.** `ai.chat_sessions` gains `tenant_id` and
`owner_user_id`, both `NOT NULL`, both plain `uuid` with no foreign key — the harness is
domain-agnostic and must not depend on `commerce.organizations` existing. Every
`SessionService` and `SessionSummaryService` read filters on the tenant, including the ones
that run inside an already-authorised turn; a session id from another tenant simply does
not exist. A role guard does not substitute for this: a role says what a caller may do, not
whose data they may see.

**The memory scope is a function of the run context**, `scope: (ctx) => string`, resolved
per request. `RunContext.principal.tenantId` is how tenancy crosses into a package that has
no idea what a tenant *is*: the application passes its organisation id, the harness uses it
to build a namespace and stamp ownership, and interprets it no further.

**Consolidation adjudicates against every namespace retrieval reads.** A pass writes to
`<scope>:<strategy>` but judges candidates against `[<scope>, <scope>:<strategy>]`. Drop the
bare scope and a directly-written memory can never be contradicted — retrieval keeps
recalling it as fact, outliving the correction meant to replace it. Adding a namespace to
the read path means adding it to `adjudicateAgainst`.

**The embedding cache keys on `(content_hash, model, input_type)`.** The model is
asymmetric: the same sentence embeds differently as a stored document than as a search
query. Without `input_type` in the key the cache serves the wrong half of the pair, and the
calibrated score floor stops meaning anything — silently. See ADR 0003.

## Consequences
- A wrong supersede stays auditable: rows are marked, never deleted, and read paths filter
  `superseded_at IS NULL`.
- `SessionService` has no method that can read a session without a tenant, asserted by a
  test that scans its SQL, so a future method cannot quietly omit the filter.
- Postgres row-level security would make some of this redundant; it stays deferred for the
  reasons in ADR 0008, which means these clauses are the only thing standing between two
  tenants' memories.
