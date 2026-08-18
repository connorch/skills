# wovn-files

Cloudflare Worker behind `https://files.wovn.org` (public) and
`https://private.wovn.org` (private), the file host used by the `wovn-file-hosting`
skill. Authenticated uploads write to R2 and return the URL; `GET` serves
stored objects. `POST` mints an immutable dated key (`yyyy/mm/<random>-<name>`);
`PUT` writes to the exact request path, giving stable URLs for living
documents (the CLI maps `wovn put` to POST and `wovn put --at` to PUT). A
`PUT` to an existing key is rejected with 409 unless the request carries the
`x-wovn-force: 1` header (the CLI's `--force`), so paths are never clobbered
by accident. A forced overwrite first copies the old version to
`archive/<path>/<timestamp>-<random>`, preserving its content type and
metadata (plus the original upload time as `uploaded`), so stable paths keep
their full history; the `archive/` prefix is reserved (PUT rejects it) and
hidden from `/?list`. `GET /<path>?history` (same auth as listing) returns
`{current, versions}` for a stable path, versions newest first (the CLI maps
`wovn history` and `wovn diff` onto it). Uploads may carry the client's git
context in `x-wovn-dir`,
`x-wovn-branch`, `x-wovn-worktree`, `x-wovn-project`, and
`x-wovn-project-path` headers (the CLI infers and sends these automatically);
they are stored as R2 customMetadata. `GET /?list` (optional `limit`, default
20, max 1000) returns recent objects as JSON, newest first; `project`,
`branch`, `worktree`, and `dir` query params filter on the stored context
(`project` matches the project name or its full path, the rest match
exactly); a `type` param (comma-separated categories from `TYPE_CATEGORIES`
and/or bare extensions) filters by the extension in the key, before the limit
is applied. Listing requires the upload token on the public host (generated
URLs are unguessable capability URLs, so the listing must not be open) and
rides the Access check on the private host.
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
`--force` to replace), tagging each upload with the git context it ran in
(directory, branch, worktree, project), `wovn list` shows recent files on both
hosts (`--project` / `--branch` / `--worktree` / `--dir` filter by that
context; bare flags infer the current environment, and `--type` filters by
file type),
`wovn read <url-or-path>` prints a hosted file (handling private auth),
`wovn history <url-or-path>` lists all versions of a stable path,
`wovn diff <old> [new]` git-diffs two hosted files (one argument = previous
vs current version of a stable path),
`wovn rotate` rotates the token. Build and install:
`pnpm install && pnpm build` in `../cli`, then `cp ../cli/dist/wovn
~/.local/bin/wovn` (re-run after editing `../cli/src/wovn.ts`).

## Token rotation

The upload token lives in two places: the `FILE_HOST_TOKEN` Worker secret
(server side) and `~/.config/wovn-files/token.txt` (client side, exported
into the shell env by `~/.zshenv`). `wovn rotate` updates both: it sets the
Worker secret first (via npx wrangler, pinned to the personal account), then
writes the token file. Open a new shell if anything relies on the stale
`FILE_HOST_TOKEN` env var; `wovn` itself reads the file and keeps working.
