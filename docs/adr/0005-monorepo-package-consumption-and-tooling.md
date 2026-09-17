# 0005 — Monorepo package consumption and tooling versions

**Status:** accepted · 2026-09-17 (amends the planned "source consumption only" approach)

## Context
The workspace has a NestJS API (CommonJS, needs `emitDecoratorMetadata`), a Vite SPA (ESM,
esbuild/oxc — no decorator metadata), and two shared packages. Mismatched module formats and
duplicate `zod` copies are the usual failure points of such a monorepo.

The plan was to consume shared packages from source everywhere via tsconfig `paths`. That
does not work for the API: Node cannot execute `.ts`, and `tsc` does not rewrite `paths`
when emitting, so the compiled API would `require` a package with no JavaScript in it.

## Decision
| Consumer | How it consumes `@stockflow/contracts` |
|---|---|
| API runtime / build / typecheck | **Built package** (`dist/`, CommonJS + `.d.ts`), via `main`/`types`/`exports` |
| API tests (Vitest) | Source, via `resolve.alias` |
| Web (Vite) | Source, via `resolve.alias` and tsconfig `paths` |

- `packages/contracts` is plain Zod, no decorators, so every consumer can compile it.
- `packages/ai-harness` may use Nest decorators, so only the API consumes it.
- `zod` is pinned once through a root `pnpm.overrides`; packages declare it as a peer.
- `reflect-metadata` is imported once, in `apps/api/src/main.ts`.
- `pnpm -r build` builds packages before apps (topological order). In development, build
  `contracts` once before running the API.

### Versions
- **NestJS 11.2.x**, not 12: the plan constrains v11, and the AI-Harness code to be ported
  targets v11.
- **TypeScript 5.9**, not 7: Nest DI depends on `emitDecoratorMetadata`; TypeScript 7 (the
  native rewrite) is not yet verified for it here.
- **ESLint 9 flat config** (`eslint.config.mjs`); legacy `.eslintrc` is no longer supported.
- **Vitest 3.2** + `unplugin-swc`, because Vitest's default transform emits no decorator metadata.
- **pnpm 9** installed with npm (corepack could not write to `Program Files` on this machine).

## Consequences
- One extra build step for the API, in exchange for a runtime that needs no loader.
- Upgrading Nest or TypeScript is a deliberate, separate change.
