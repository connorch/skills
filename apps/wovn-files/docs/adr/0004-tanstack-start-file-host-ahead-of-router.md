---
status: accepted
---

# TanStack Start on the Worker, with the file host ahead of the router

The Banner (ADR 0003) needs server-rendered markup for HTML Files and app
pages for everything else, and more server-rendered surfaces are coming. We
decided to merge the `ui/` SPA and the `worker/` into one TanStack Start app
in `app/` on the same Cloudflare Worker (React Query for data and mutations,
shadcn and Tailwind, R2 unchanged; the CLI is untouched), rather than keep
extending the SPA with hand-rolled server rendering.

## The file host runs in the server entry, not in routes

Uploads, `/api`, `/login`, Raw serving, and HTML Banner injection run in
Start's custom server entry before the router, and only authenticated
app-page requests are handed to the Start handler. This is an invariant:
everything the router, loaders, and server functions see is already
authenticated, so none of them carry auth checks. We rejected doing the
resolution in a catch-all route's server handler because a route handler can
only defer to page rendering when the route has a component, which makes
the entry wrapper both simpler and safer.

## Consequences

- One package, one tsconfig (`wrangler types` output coexists with the DOM
  lib), one deploy.
- The Banner ships as a second, hand-configured Vite build with fixed output
  names under the reserved `/_/` prefix, because Start's manifest allows one
  client entry; server functions are also based under `/_/` so one Reserved
  Key covers everything the app serves.
- Modules that import `cloudflare:workers` stay out of client-reachable
  files (routes, server-function files), or the Start build fails to
  resolve them.
- The injected Banner is verified through a production build and
  `vite preview`; app pages get HMR through `vite dev`. The injector has no
  dev mode.
