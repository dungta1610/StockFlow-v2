# Code Review: Phase 00 (foundation) + Phase 01 (identity/auth/RBAC)

Reviewer: code-reviewer · 2026-09-17 · I only reviewed and changed no files. I wrote only this report.

## Scope
- Files reviewed: `apps/api/src/**` (platform, identity, app.module, main, cli), `db/migrations/001–002`, `packages/contracts/src/**`, `apps/api/test/**`, `vitest.config.ts`, compose, Dockerfiles, `eslint.config.mjs`, `.env.example`, `docs/code-standards.md`, ADR 0001–0009. I also compared against the StockFlow Go `module/user/**`.
- Size: about 2.2k LOC of source and 1.9k LOC of tests.
- Checks I ran myself:
  - Lint-rule probes through `eslint --stdin`: all 3 boundary rules fire.
  - `pnpm migrate` against the live DB: `0 applied, 2 already applied`.
  - Live API probes (read-only), covering malformed JSON, paging extremes, filters and the refresh cookie.
  - A repro with a pg Pool and no error listener (below).
  - `pnpm -r typecheck` is clean.
- `pnpm lint` fails **right now**, but only because of `apps/api/test/verification/*.spec.ts`. Another agent created those files while this review was running (unused `withDb` and `codes`). They are outside the reviewed code, but they need fixing before anything is committed.

## Overall assessment
The implementation is solid:
- Tenancy goes through one `scopeSql`.
- Reads outside the caller's scope return 404.
- Role and org type are tied together by a composite FK + CHECK, which is better than the plan's CHECK function.
- The refresh claim is a single-statement conditional UPDATE, and the CSRF check runs before the token is touched.
- Hashes cannot leak because the presenters have no field for them.
- Use cases never open transactions, and the ADRs record the deviations honestly.

It is not ready to ship. Two High defects are real and reproducible, and a few Medium items should be fixed before Phase 02 builds on this code. There are no Critical findings.

---

## Critical
None.

## High

### H1. The pg Pool has no `'error'` listener, so a Postgres restart or a killed backend crashes the API
- **Where:** `apps/api/src/platform/database/pool.ts:16-25`. `grep "on('error'"` finds only the Redis listener.
- **What is wrong:** pg-pool re-emits errors from idle clients on the pool. With no listener, Node throws an `Unhandled 'error' event`.
- **Proof:** I ran a scratch script (`new Pool` → `pg_terminate_backend(own pid)`) against the live DB. The process exited with **code 1** and `throw er; // Unhandled 'error' event … terminating connection due to administrator command`.
- **How it fails:**
  - Postgres restarts, fails over, or an idle connection is killed by `idle_session_timeout` or a DBA, and the API process dies.
  - The compose `api` service has no `restart:` policy (`docker-compose.yml:86-108`), so it stays down.
  - `/health` never gets the chance to return 503.
- **Fix:** In `createPool`, add `pool.on('error', (err) => logger.warn(...))`. Add a test that terminates an idle pooled backend and asserts the app still answers `/health`. Also add `restart: unless-stopped` to `api`.

### H2. The login lockout is check-then-act, so concurrent attempts bypass the per-account and per-IP limits
- **Where:** `apps/api/src/modules/identity/application/use-cases/login.use-case.ts:49-54` (the `isBlocked` read), then `:57-60` (argon2 verify, tens of ms), then `:63-64` (the `hit`).
- **What is wrong:** Every request in a parallel burst reads the counter before any of them increments it.
- **How it fails:**
  - From one IP, the only effective cap is the global guard: 100 requests/min per IP per route (`rate-limit.guard.ts:42`). That allows about 1,500 guesses per account per 15 minutes instead of the intended 5.
  - From N IPs, it becomes N × that.
  - This breaks the Phase 01 success criterion "Login brute-force bị chặn theo account". `login-throttle.spec.ts` sends attempts sequentially, so it cannot catch this.
- **Fix:** Reserve the attempt atomically before verifying.
  - Option A: `INCR` both keys first (`hit`). If either count is over the limit, reject. On success, `DEL` the account key.
  - Option B: use a Lua script that does check-and-increment.
  - Add a test that fires about 20 parallel wrong-password logins at one account and asserts at most `LOGIN_MAX_ATTEMPTS` reach password verification. Spy on the `PasswordHasher` or count 401 vs 429.

## Medium

### M1. The compose defaults expose a known ops_admin credential and a known JWT secret on every network interface
- **Where:**
  - `docker-compose.yml:79-80`: `SEED_ALLOW` defaults to true, with a well-known password.
  - `:89`: `NODE_ENV` defaults to `development`, which overrides the image's `production` (`apps/api/Dockerfile:23`).
  - `:92`: the fallback `JWT_SECRET` is a hard-coded, publicly known string.
  - `:20`, `:32`, `:97`: ports are published as `"3100:3000"` etc., which binds to 0.0.0.0.
  - `env.schema.ts:24` only checks the secret's length.
- **How it fails:**
  - Anyone on the same LAN or Wi-Fi can log in as `ops.admin@stockflow.local` / `ChangeMe-123!`.
  - Anyone can mint their own ops_admin token with the known secret.
  - Anyone can reach Postgres on 5433 with `stockflow/stockflow`.
  - If someone later sets `NODE_ENV=production` but forgets `JWT_SECRET`, the known secret is still accepted.
- **Fix:**
  - Publish ports as `127.0.0.1:${API_PORT:-3100}:3000` (same for pg, redis and litellm).
  - In `envSchema`, add a `superRefine` that rejects the dev fallback secret when `NODE_ENV=production`.
  - Consider `${JWT_SECRET:?set JWT_SECRET}` outside the dev profile.

### M2. Authorization for user and organisation admin exists only as `@Roles` on the HTTP routes; the use cases never check the actor
- **Where:**
  - `user.use-cases.ts:35-49` (create) and `:88-129` (update): these check only scope.
  - `organization.use-cases.ts:18-28`: `CreateOrganizationUseCase` does not even take an `Actor`.
  - `user.use-cases.ts:16-17` and `organization.use-cases.ts:12` say "Route guards restrict…".
- **How it fails:**
  - Phase 08 exposes application services as copilot tools, and the plan's AC#5 relies on "mọi tool qua application service có guard".
  - Say a later tool (or a job, or another controller) calls `CreateUserUseCase` for a plain `buyer`. The scope is `single` on their own org, so the buyer can create users, including a `buyer_admin`. `CreateOrganizationUseCase` has no check at all.
  - This is the exact kind of privilege escalation the plan's red team warned about.
- **Fix:** Enforce the role inside each use case, e.g. `if (!hasRole(actor, 'ops_admin','buyer_admin')) throw forbidden()`. `CreateOrganizationUseCase` must take an `actor` and require an internal `ops_admin`. Keep `@Roles` on the routes as a second layer.

### M3. The `all-buyers` scope, which Phases 02, 04 and 08 depend on, has no test against the database
- **Where:** `scope-sql.ts:19-20`. The only tests are the pure-function ones in `test/identity/org-scope.spec.ts:57-59`. Grepping for `all-buyers` finds no HTTP or DB test.
- **What is missing:** Plan test #10 (`ops-can-read-all-buyers`) became `tenant-isolation.spec.ts:381-405`. That exercises the **identity** scope `all`, not `all-buyers`. So "ops reads every buyer org through OrgScope and never sees internal data" is unproven at the SQL level.
- **How it fails:** A typo in the column mapping, or passing `cols.type` for the wrong alias, ships unnoticed until Phase 04.
- **Fix:** Add a repository-level test with a throwaway table or view keyed by org. Run `scopeSql({kind:'all-buyers'})` and assert that rows for both buyer orgs are returned and the internal org's row is not. Alternatively, record in the phase file that test #10 is deferred to Phase 02 and make it a blocking test there.

### M4. Two tabs refreshing at once, a normal SPA pattern, revokes the whole session
- **Where:** `refresh-session.use-case.ts:27-33`. ADR 0009 already lists this as a known limit.
- **How it fails:** Two tabs wake up with expired access tokens and both POST `/auth/refresh` with the same cookie. One claims the token. The other sees `spent` and revokes the family, including the token that was just issued. The user is logged out. With 15-minute access tokens this will happen daily in the Phase 09 console.
- **Fix, option A:** Add a short reuse grace period. Store `replaced_by`. If a spent token is presented within about 10 s of `used_at` and its successor is still unused, return 401 **without** revoking.
- **Fix, option B:** Require Phase 09 to coordinate refreshes across tabs (BroadcastChannel or Web Locks), and write that into phase-09 as an acceptance criterion now.

### M5. Sessions have no absolute lifetime
- **Where:** `session-issuer.ts:45`. Every rotation issues a fresh 7-day expiry, and `refresh_tokens` has no family `created_at` bound.
- **How it fails:** A stolen refresh token that the attacker keeps using works forever, as long as the victim never uses the same family again. Reuse detection only fires if both parties keep refreshing.
- **Fix:** Carry `family_started_at` in the token row, or look it up with `MIN(created_at)` per family. Refuse refresh after N days (for example 30), then require a new login.

## Low

- **L1. Some errors skip the request-logging middleware.**
  - Where: `request-logging.middleware.ts`.
  - Body-parser errors happen before Nest middleware runs. Live `POST /auth/login` with `{bad` returned 400 with **no `x-request-id`**, and the filter logged `[-]`. This contradicts the Phase 00 requirement "x-request-id trên mọi response".
  - Fix: create the app with `bodyParser: false`, register the request-id middleware with `app.use` first, then `app.use(express.json())`.
- **L2. A filtered user list returns only some of each user's memberships.**
  - Where: `sql-user.repository.ts:84-92`. `json_agg` runs after the `m.role` and `m.org_id` filters.
  - Live probe: `GET /users?email=distributor…&org_id=<A>` shows only BUYER-A, while `GET /users/:id` shows A and B. An admin reading the list cannot tell that the account is shared, and those are exactly the accounts whose account-level fields they are not allowed to edit.
  - Fix: filter users with `EXISTS (…)` or a CTE, and aggregate the in-scope memberships separately.
- **L3. `GetCurrentSessionUseCase` throws Nest's `UnauthorizedException` from the application layer.**
  - Where: `get-current-session.use-case.ts:15`.
  - This breaks code-standards §7 ("Modules throw DomainError").
  - Fix: add something like `IdentityErrors.sessionInvalid()`.
- **L4. Any stranger can lock a real account for 15 minutes with 5 bad attempts, including `ops_admin`. The per-IP bucket also blocks *successful* logins.**
  - Where: `login.use-case.ts:49-54`.
  - Behind a NAT or proxy (no `trust proxy` is configured in `configure-app.ts`), a single attacker can lock out everyone who shares that IP.
  - Fix: write down the tradeoff. Before deployment, configure `app.set('trust proxy', …)` and consider exponential backoff instead of a hard lock.
- **L5. Role changes on the access token take up to 15 minutes to apply.** The token's roles are not re-checked on requests (`jwt-auth.guard.ts:28-30`). ADR 0009 mentions this for deactivation only. It should also cover demotion, and access tokens are not revoked on logout either.
- **L6. `identityScopeOf` returns `all`, which also includes internal-org rows.**
  - Where: `org-scope.ts:26-28`.
  - A future commerce repository could be handed an `all` scope by mistake, because the type allows it.
  - Fix: use a branded or separate `IdentityScope` type, or make commerce ports accept `Exclude<OrgScope, {kind:'all'}>`.
- **L7. The per-connection settings do not include `default_transaction_isolation`.**
  - Where: `pool.ts:20-24`.
  - The plan requires it. `withTransaction` sets the isolation level explicitly, but `uow.db` and raw pool queries rely on the server default.
  - Fix: add `-c default_transaction_isolation=read\ committed`.
- **L8. The test pool is not raised to 60 or more.** `DB_POOL_MAX` defaults to 20 and `test/setup.ts` does not set it (plan Phase 00, "Pool Postgres của test đặt ≥60"). This is a prerequisite for the Phase 04 test with 50 concurrent requests.
- **L9. Argon2 hashing runs inside an open transaction.** Where: `user.use-cases.ts:44` and `:116`. It holds a pool connection for the length of the hash. With a 20-connection pool, bulk admin writes will starve other requests. Fix: hash before calling `withTransaction`, or accept it and document why.
- **L10. The migrator has no checksum and no timeouts.** Where: `migrator.ts:39-55`. If someone edits an already-applied migration, the change is silently ignored.
- **L11. The seed CLI prints the password.** Where: `cli/seed.ts:98`. That includes a custom `SEED_PASSWORD`, which ends up in the compose logs.
- **L12. The `is_active` query parameter is stricter than in StockFlow.** v2 accepts only `true`/`false` (`contracts/identity.ts:12`). Go's `strconv.ParseBool` also accepted `1`/`t`/`TRUE`. `role` is now an enum, so an unknown role returns 400 where Go returned an empty list. Both changes are acceptable but should be recorded as deliberate.
- **L13. The plan text is out of date on the cookie path.** `phase-09-web-ops-console.md:33` still says `Path=/auth/refresh`, but ADR 0009 changed it to `/auth`.
- **L14. Orphan accounts.** Where: `sql-user.repository.ts:66-67`. An account with zero memberships is invisible to everyone, including ops_admin, because of the inner `JOIN`, and its email can never be reused.
- **L15. Redis errors are swallowed without any log.** Where: `redis.module.ts:49`. After boot, a Redis outage leaves no log line; the only symptom is 429s and 503s.

---

## (a) Acceptance / success criteria

### Phase 00

| Criterion | Status |
|---|---|
| Spike: chat, 1024-dim embedding, tool-event verdict | **Not met.** Accepted as pending (ADR 0003) |
| Embedding dimension matches the Phase 07 `vector(N)` | **Not met.** Depends on the spike |
| `docker compose up` → all healthy, `/health` ok | Met (`docker ps`: 5 healthy, migrate exited 0) |
| `pnpm migrate` run twice is idempotent | Met (`0 applied, 2 already applied`, plus `migrate.spec.ts`) |
| The 7 tests pass | Met (isolation test split into `isolation-a/b.spec.ts`) |
| `SHOW` isolation, lock and statement timeouts | Met (`transaction-settings.spec.ts`). See L7 |
| Limiter blocks per key only | Met (`ratelimit.spec.ts:33`) |
| Two test files do not break each other's fixtures | Met, though the test is timing-based (300 ms sleep) and therefore weak |
| ESLint rules for `pg` in copilot and `platform`→`modules` | Met (verified with stdin probes; `copilot/infrastructure/**` is exempt, which matches the Phase 08 design) |
| code-standards and ADR 0001–0006 exist | Met |
| Test pool ≥60 (Architecture section) | **Not met** (L8) |
| `x-request-id` on every response | **Partly met** (L1) |

### Phase 01

| Criterion | Status |
|---|---|
| The 12 tests pass | Met by mapping: tests #7, #9 and #10 were merged into `org-scope.spec` and `tenant-isolation.spec`. Test #10 only covers the `all` scope (M3) |
| Ops reads all buyers through OrgScope, and no `if internal` branch exists | The grep is clean (only `isInternalOps` in the domain). **Not proven at the SQL level** for `all-buyers` (M3) |
| Cross-org get-by-id returns 404 | Met |
| DB refuses `ops` in a buyer org | Met (plus the "membership lies about its type" case) |
| Refresh with a foreign Origin returns 403 and does not revoke | Met |
| Reusing a token revokes the family | Met |
| Same message for a wrong email and a wrong password | Met (plus dummy-hash timing) |
| Brute force blocked per account | **Only for sequential attempts; parallel attempts bypass it (H2)** |
| No token → 401 | Met |
| Seed gate | Met |
| No repository reads org data without a scope | Two exceptions, both justified because they are auth-internal and keyed by the caller's own identity: `findCredentialsByEmail` and `findActiveMembership` |
| ADR 0007–0009; 0007 covers multi-membership | Met |

## (b) StockFlow parity
- **Kept:**
  - Routes: POST, GET, GET `:id` and PUT `:id` on `/users` (`user.controller.ts:23-88`).
  - Response shapes `{data}` and `{data, paging:{page,limit}}`.
  - Paging defaults 1/10 with a cap of 100 (`contracts/common.ts:24-27`).
  - Filters: exact email (citext), `full_name` ILIKE with escaping, `role`, `is_active`.
  - PUT requires `full_name` and `role`.
  - `ORDER BY created_at DESC`, now with `id` as a stable tie-break.
  - Email normalisation.
- **Deliberate differences:**
  - The client sends a plain password instead of a hash.
  - The role now lives on the membership.
  - Stricter parsing of `is_active` and `role` (L12).
  - Filtered lists show only some memberships (L2).
- No regression found.

## (c) Security summary
- **Tenant isolation:** sound. `findById` reuses the same `$2` for both `FILTER` and `bool_or`, which I verified. Cross-org access returns 404.
- **Refresh:** the atomic claim is correct. Cross-tab refreshes cause spurious revocation (M4), and sessions have no absolute lifetime (M5).
- **CSRF:** the Origin allow-list runs before the token is touched, and a failure does not clear the cookie. A null Origin is refused. A missing Origin is allowed, which is acceptable with SameSite=Strict.
- **JWT:**
  - HS256 is pinned on both sign and verify.
  - Claims are validated with zod.
  - The secret must be at least 32 characters, but the known dev fallback is still accepted (M1).
- **Leaks:**
  - Presenters have no hash fields.
  - The filter logs only method, URL and code.
  - 500 responses are generic.
  - Tokens are never put in URLs.
- **Enumeration:** handled, apart from the lockout DoS (L4).

## (d) SQL, transactions and the migrator
- **SQL:**
  - `json_agg … FILTER` is correct.
  - `GROUP BY u.id` is valid (functional dependency on the PK).
  - `escapeLike` covers `\`, `%` and `_`. I tested this live: `%` and `_` return no matches.
  - Paging works even at `page=2^53-1`.
- **Transactions:**
  - `withTransaction` is called only from controllers.
  - Refresh, login and logout run on autocommit on purpose, and ADR 0009 documents it.
- **Migrator:**
  - A session-level advisory lock is released in `finally`.
  - `search_path=commerce,public` is set and verified by `testcontainers.spec.ts:19`.
  - Each file runs in its own transaction.
  - See L10.

## (e) Architecture rules
- `platform/` does not import `modules/` (lint and probe both confirm).
- `public.decorator` correctly lives in `platform/http`.
- No money fields exist yet; `credit_limit` is `numeric(18,2)`.
- Errors are `DomainError`s, except L3.
- Authorization lives only in the HTTP layer (M2).

## (f) Deviations from the plan

| Deviation | Verdict |
|---|---|
| Guards in `modules/identity/http` | **Justified.** They need `AccessTokenService`, and the lint rule forbids `platform`→`modules`. Only `@Public` is shared, and it stays in `platform` |
| Composite FK instead of a CHECK function | **Justified and better.** It survives dump/restore, and `ON UPDATE CASCADE` plus the CHECK blocks changing an org's type. Tested |
| Lockout counters in Redis instead of DB columns | **Justified** for enumeration resistance. The implementation is racy (H2) |
| Cookie `Path=/auth` | **Justified,** because logout needs the cookie. Update the phase-09 text (L13) |
| `OrgScope` gains an `all` variant | **Justified** for identity admin. Narrow the type so commerce code cannot receive it (L6) |
| Contracts consumed as a built package by the API | **Justified,** since Node cannot run `.ts` and `tsc` does not rewrite paths. Risk: tests use the source alias while typecheck and runtime use `dist`, so a stale `dist` can hide drift. Build contracts in `pretypecheck` or `pretest` |
| Vitest config in `apps/api` | **Justified,** because there is only one test project |
| Request logging as middleware | **Justified,** because interceptors never run when a guard rejects. Body-parser errors still slip past it (L1) |
| Spike script is `.mts` | **Justified** (the SDK is ESM, and `tsx` runs it) |
| NestJS 11 / TS 5.9 | **Justified.** The plan requires Nest 11, and TS 7's decorator-metadata support is not yet verified here |
| Host ports 3100/5433/6380/4001 | **Justified** to avoid clashes. They must be bound to 127.0.0.1 (M1) |

## Recommended actions (in order)
1. H1: add a pool `'error'` listener and a restart policy.
2. H2: make the lockout atomic (increment first), and add a test with parallel attempts.
3. M1: bind ports to loopback and reject the dev JWT secret in production.
4. M2: check roles inside the admin use cases, and give `CreateOrganizationUseCase` an actor.
5. M3: add an `all-buyers` scope test against the database, or explicitly make it a blocking test in Phase 02.
6. M4 and M5: add a refresh grace window (or make cross-tab coordination a Phase 09 acceptance criterion) and an absolute session lifetime.
7. L1, L2, L7 and L8 before Phase 04. The rest can be picked up opportunistically.
8. Fix the lint errors in `apps/api/test/verification/*` before committing.

## Metrics
- Typecheck: clean.
- Lint: 3 errors, all in the new `test/verification` files and none in the reviewed code.
- Tests: the caller reports 132/132 passing. I did not re-run them, to avoid starting more containers.
- Coverage: not measured.

## Unresolved questions
- Is the local stack meant to be reachable from the LAN? That decides whether M1 is Medium or Low.
- Which fix does the user want for M4: a server-side grace window or client-side coordination across tabs?

## Verdict
**REQUEST_CHANGES.** H1 and H2 must be fixed. M1 and M2 should be fixed before Phase 02 starts using these services.

Status: DONE_WITH_CONCERNS
Summary: Phases 00 and 01 meet almost all criteria, apart from the accepted Bedrock spike gap and the ≥60 test pool. Two High defects need fixing: an unhandled pg Pool `'error'` crashes the API (reproduced), and the login lockout can be bypassed with concurrent requests.
Concerns/Blockers: `pnpm lint` currently fails because of `apps/api/test/verification/*`, which another agent added while this review was running.
