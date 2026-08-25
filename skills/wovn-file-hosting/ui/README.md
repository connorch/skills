# wovn browse UI

Vite + React + shadcn SPA served by the worker at `files.wovn.org/_/`. One
dense table per directory level (via `GET /_/api/browse`), with visibility
flips, stable-path version history, copy-URL, and delete. Auth is the host's
cookie/token; see `../worker/README.md`.

Built with `base: "/_/"` and `outDir: "dist/_"`, so `pnpm build` produces
`dist/_/...` and the worker's assets binding (`../ui/dist`) maps it to `/_/`
URLs. Build here before `pnpm run deploy` in `../worker`.

```sh
pnpm install
pnpm typecheck && pnpm lint
pnpm build
```

Add components with `pnpm dlx shadcn@latest add <name>` (registry files live
in `src/components/ui/`, exempt from the react-refresh lint rule).
