# 0009 — Tokens, refresh transport, CSRF and login throttling

**Status:** accepted · 2026-09-17

## Decision

### Access token
- HS256 JWT, 15 minutes, claims `{ sub, org, ot, roles }` validated with a schema on the
  way back in. Sent only in the `Authorization` header and kept only in memory by clients.
- **Tokens never appear in URLs** (logs and proxies record URLs). Streaming endpoints will
  use `fetch` with headers, not `EventSource`.
- The account is not re-checked on every request; the 15-minute lifetime bounds how long
  a deactivated user keeps access. Refresh does re-check it.

### Refresh token
- 256 random bits, stored only as SHA-256. 7 days.
- Cookie `sf_refresh`: `HttpOnly; Secure; SameSite=Strict; Path=/auth`.
  *Changed from the plan's* `Path=/auth/refresh` — logout must receive the cookie too.
- Rotation: using a token marks it used in one statement and issues a new one in the same
  family. Presenting a used or revoked token revokes the **whole family**.
- A revoked family **stays dead**: the claim also requires that no token of the family has
  been revoked. Without this, a refresh that was mid-flight when reuse was detected could
  insert its new token *after* the revocation and that token would work.
- Every session has an absolute end (`session_expires_at`, 30 days). Rotation carries it
  forward unchanged and a new token never expires after it, so a session that keeps being
  refreshed still ends.
- Refresh runs on an autocommit connection so that revocation persists even though the
  request fails (inside a transaction, the error would roll it back). A crash between
  consuming the old token and storing the new one logs the user out once.
- Two browser tabs refreshing the same token at the same moment trip reuse detection and
  both get logged out (pinned by `test/verification/concurrent-refresh.spec.ts`). This is
  solved in the web client, which serialises refreshes across tabs with the Web Locks API.
  A server-side grace window was rejected: a stolen token replayed inside the window would
  go undetected.

### CSRF
Refresh and logout are authenticated by a cookie browsers attach automatically. A forged
cross-site refresh would rotate the token and — through reuse detection — get the
victim's real session revoked, repeatedly. Both endpoints therefore reject a request whose
`Origin` is not in `CORS_ORIGINS` **before touching the token**. Requests without `Origin`
(non-browser clients) are allowed: they cannot carry another user's cookie.

### Login throttling
- Attempts are counted in Redis per account (`LOGIN_MAX_ATTEMPTS`) and per client IP
  (`LOGIN_MAX_ATTEMPTS_PER_IP`) in a fixed window, **before** the password is checked.
  Checking the counter first and counting after a failure let a burst of parallel requests
  all pass the check (20 guesses instead of 5). A successful login resets the account
  counter and gives its IP hit back, so in effect only failures count. The give-back is a
  Lua script: a plain `DECR` on a just-expired key would recreate it at -1 with no TTL.
- *Changed from the plan's* `failed_login_count` / `locked_until` columns: a database
  column cannot count attempts against emails that do not exist, and locking only real
  accounts would reveal which emails are registered.
- Unknown email, wrong password and inactive account return the same error, and a dummy
  argon2 verification runs for unknown emails so timing does not differ.
- Passwords: argon2id (`@node-rs/argon2`), 8–128 characters.

### Demo data
`pnpm seed` / the compose `migrate` service create demo organisations and accounts with a
shared password. The seed refuses to run unless `SEED_ALLOW=true`, and never when
`NODE_ENV=production`.
