# 0023 — Agent tools call application services, never repositories

**Status:** accepted · 2026-09-20

## Context
An agent that can read inventory, orders and contract prices is a new caller of
everything those words touch. The question is not whether it is useful — it is whether
adding it widened the attack surface.

It would, if the tools queried the database. Every guard the system has — role checks,
`OrgScope` filtering, "not found" instead of "forbidden" for another tenant's rows — lives
in the application services. A tool with its own SQL would be a second road to the same
data with none of that, built by whoever wrote the tool, reviewed as an AI feature rather
than as an authorisation change.

Text-to-SQL is the extreme case of the same mistake: it hands query construction to a model
and leaves no place to put a check at all.

## Decision

**A tool is a zod schema and one call to an application service.** Nothing else. If a tool
seems to need logic, that logic belongs in the service, where the HTTP layer gets it too.

**`modules/copilot/application/` and `modules/copilot/http/` contain no SQL and import no
repository.** One file speaks SQL — `infrastructure/sql-proposal.repository.ts`, behind the
proposals port — and `copilot.module.ts` binds it, which is composition. Enforced three
ways: `eslint.config.mjs`, `scripts/verify-architecture.sh`, and
`test/copilot/no-sql-in-copilot.spec.ts`.

**No text-to-SQL, under any circumstances.** There is nowhere in this structure to put it.

**Tools are built per request, from factories.** `ToolFactory` receives the `RunContext`,
and the handler resolves the caller from it on every call. An instance built once at boot
would either have no caller or keep the first one and hand their scope to everyone after.
Resolving per call also means a role revoked mid-conversation takes effect on the next tool
call rather than at the next login.

**No tool schema has a field for an organisation.** A model cannot ask about a tenant it
was not already acting for, because there is no field to put one in; scope comes from the
caller. The one exception is `get_contract_price`, which exists to answer "what does
customer A pay?" — it takes the customer's *code* (harder to invent than a uuid), resolves
it inside the caller's scope, and re-checks the result with `assertOrgInScope`. A test
asserts that no other tool has such a field.

**The copilot is operations-only**, asserted in the copilot's own actor resolution as well
as on the route, because a tool is reachable from anywhere the harness runs.

## Consequences
- The agent travels the road the HTTP controllers already travel. An authorisation bug
  would have to be a bug in a service the whole application shares — not a new one.
- Prompt injection in stored data cannot widen a result set: the limit is a `WHERE` clause
  derived from the caller before the model is involved. `test/copilot/prompt-injection.spec.ts`
  puts an injection into a product name and checks exactly that.
- A tool that wants data no service exposes is a request to extend a service, reviewed as
  such. That friction is the point.
- Adding a tool is one file plus one line in the registration list, with no change to
  `packages/ai-harness` — `test/copilot/adding-a-tool.spec.ts` builds an eighth tool to
  prove it, and shows it inherits the caller rules for free.
