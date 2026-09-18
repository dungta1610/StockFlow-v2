# 0025 — The ops console is a plain SPA, not server-rendered

**Status:** accepted · 2026-09-19

## Context
Phase 09 needed a web UI so Phases 00–04 (and, once landed, 05) had something a
person could click through instead of `curl`. The audience is internal: ops staff
and buyer-organisation admins signed in behind the API's own auth, never an
anonymous visitor. React 19 offers a server-rendering path (Server Components,
streaming SSR via a framework like Next.js or Remix); Vite's plain SPA output
(`apps/web/Dockerfile` → static files behind nginx) was chosen instead.

## Decision
- **No SSR framework.** `apps/web` is Vite + React 19 + TanStack Router/Query,
  built to static assets and served by nginx (`apps/web/nginx.conf`) behind
  `try_files $uri /index.html` — client-side routing only.
- **Why SSR earns nothing here:**
  - *SEO* is the usual reason to render on the server. An ops console sits behind
    a login; there is nothing for a crawler to index.
  - *First paint on a slow client* matters for a public storefront, not for staff
    who load the app once per shift on a company machine.
  - *Streaming* server output would still need every data call to carry the same
    access token this app already sends as an `Authorization` header — SSR would
    add a second place (the server render) that has to hold and refresh that
    token, alongside the browser's own refresh-mutex work (see phase-09's
    architecture notes). That is a second identity to keep synchronised for no
    reader-facing benefit.
- **What an SPA gives up, accepted deliberately:** a user with JavaScript
  disabled gets nothing, and the first request is a blank shell until the bundle
  loads. Both are fine for an internal tool on a modern browser.
- **What an SPA gives back:** the same access-token-in-memory model as the rest
  of Phase 09 (docs/adr/0009's refresh-cookie contract) works unmodified — no
  server-side session store, no second CORS surface, no framework-specific data
  loader reimplementing what TanStack Query already does client-side. Docker
  packaging is a single static-file image instead of a Node server process to
  keep alive, patch and scale.
- **Left for v1.1 if ever needed:** a public buyer-facing storefront (mentioned
  in phase-09 as a v1.1 possibility) is exactly the case where SSR's SEO and
  first-paint arguments would apply again — that is a new app, not a reason to
  retrofit SSR onto the ops console.

## Consequences
- `apps/web/Dockerfile` builds static assets only; `docker-compose.yml`'s `web`
  service is nginx, with no Node runtime and no server-side environment
  variables to manage in production.
- Every route guard (`_authed` in `router.tsx`) and every data fetch runs in the
  browser; there is no server render to keep behaviourally identical to the
  client one.
- If the product ever needs a public, SEO-visible page, that page belongs in a
  separate app (or a separate build target), not bolted onto this console.
