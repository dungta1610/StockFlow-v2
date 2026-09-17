# 0001 — Modular monolith with ports

**Status:** accepted · 2026-09-17

## Context
StockFlow (Go) is a module-first backend: each domain has `model/biz/storage/transport`,
and use cases depend on narrow per-use-case interfaces (`CreateOrderStore`). v2 is a
learning project run by one developer, with a stated goal of staying extensible.

## Decision
One NestJS process. Business modules keep StockFlow's four layers
(`domain/application/infrastructure/http`). Every module exposes its persistence and
integrations through ports. Cross-module calls go through application services only.

## Consequences
- One deploy, one database pool, no network hops between modules.
- A module can be extracted into a service later by replacing a port implementation with
  a client; callers do not change.
- Boundaries are real only if enforced — see the import rules in `eslint.config.mjs`.

## Rejected
- **Microservices now:** doubles infrastructure and forces sagas where one transaction works.
- **Flat NestJS feature folders:** loses the port boundary that makes extraction cheap.
