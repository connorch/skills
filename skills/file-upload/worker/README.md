# wovn-files

Cloudflare Worker behind `https://files.wovn.org` (public) and
`https://private.wovn.org` (private), the file host used by the `file-upload`
skill. Authenticated uploads write to R2 and return the URL; `GET` serves
stored objects. `POST` mints an immutable dated key (`yyyy/mm/<random>-<name>`);
`PUT` writes to the exact request path, giving stable URLs for living
documents (the CLI maps `wovn put` to POST and `wovn put --at` to PUT). A
`PUT` to an existing key is rejected with 409 unless the request carries the
`x-wovn-force: 1` header (the CLI's `--force`), so paths are never clobbered
by accident.
Stable objects are served with etag revalidation instead of immutable caching. Deployed on the personal
Cloudflare account (connorchev@gmail.com), pinned via `account_id` in
`wrangler.jsonc`.

## Private host

`private.wovn.org` serves the `wovn-private` bucket and sits behind Cloudflare
Access (Zero Trust app "wovn private files", team
`connorchev.cloudflareaccess.com`). Two policies: connorchev@gmail.com via
One-time PIN (browser), and the `wovn-cli` service token (CLI/agents, creds in
`~/.config/wovn-files/access.env`). The worker additionally verifies the
Access JWT itself (signature, issuer, audience, expiry), so a deleted or
misconfigured Access app fails closed rather than exposing the bucket. Private
responses are served `cache-control: private, no-store`.

## Develop and deploy

```sh
pnpm install
pnpm typecheck
pnpm run deploy
```

## The wovn CLI

`../cli` is a TypeScript commander program that wraps the host for agents and
humans: `wovn put <file...>` uploads and prints URLs (`--at` for stable paths,
`--force` to replace), `wovn read <url-or-path>` prints a hosted file
(handling private auth), `wovn rotate` rotates the token. Build and install:
`pnpm install && pnpm build` in `../cli`, then `cp ../cli/dist/wovn
~/.local/bin/wovn` (re-run after editing `../cli/src/wovn.ts`).

## Token rotation

The upload token lives in two places: the `FILE_HOST_TOKEN` Worker secret
(server side) and `~/.config/wovn-files/token.txt` (client side, exported
into the shell env by `~/.zshenv`). `wovn rotate` updates both: it sets the
Worker secret first (via npx wrangler, pinned to the personal account), then
writes the token file. Open a new shell if anything relies on the stale
`FILE_HOST_TOKEN` env var; `wovn` itself reads the file and keeps working.
