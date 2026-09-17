# 0008 — Defer Postgres row-level security

**Status:** accepted · 2026-09-17

## Context
Row-level security would enforce tenancy inside Postgres itself. It needs the tenant
per request, typically via `SET LOCAL app.org_id = …` inside each transaction.

## Decision
Not in v1. Tenancy is enforced in the repository layer through `OrgScope` (ADR 0007).

## Why
- With a shared connection pool, a forgotten `SET LOCAL` or a setting leaking between
  checkouts is a hard-to-find cross-tenant bug — the failure RLS is meant to prevent.
- Ops staff need a "every buyer" scope, which makes the policies conditional and harder
  to reason about than the single `scopeSql` function.
- Every read path already takes a required scope parameter and has isolation tests.

## Revisit when
Other services or ad-hoc tools start querying the database directly, bypassing the
application's repositories.
