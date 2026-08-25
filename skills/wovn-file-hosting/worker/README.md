# wovn-files

Cloudflare Worker behind `https://files.wovn.org`, the file host used by the
`wovn-file-hosting` skill. One hostname, one R2 bucket (`wovn-files`); every
object is private unless its customMetadata says `visibility: public` (fail
closed), and `archive/` objects are always private. See
`../docs/adr/0001-single-host-fail-closed-visibility.md` for why.

Authenticated uploads write to R2 and return the URL; `GET` serves stored
objects. `POST` mints an immutable dated key (`yyyy/mm/<random>-<name>`);
`PUT` writes to the exact request path, giving stable URLs for living
documents (the CLI maps `wovn put` to POST and `wovn put --at` to PUT). A
`PUT` to an existing key is rejected with 409 unless the request carries the
`x-wovn-force: 1` header (the CLI's `--force`), so paths are never clobbered
by accident. A forced overwrite first copies the old version to
`archive/<path>/<timestamp>-<random>` and preserves the path's visibility
unless the request restates it - updating a published document does not
unpublish it. Reserved top-level keys (`archive`, `login`) reject uploads.

`GET /?list` (authenticated) returns recent objects as JSON, newest first,
each with a `visibility` field; `project`/`branch`/`worktree`/`dir` filter on
stored git context (from the `x-wovn-*` upload headers), `type` filters by
extension, `visibility` by stamp. `GET /<path>?history` returns
`{current, versions}` for a stable path. `GET /<path>?visibility` and
`PATCH /<path>?visibility=public|private` read and flip the stamp via a
metadata self-copy - same key, same URL. `DELETE /<path>` removes the object
plus its whole `archive/<path>/` history (an archive URL deletes one
version) and returns the deleted keys.

## Auth

Two interchangeable credentials, accepted on every route:

- The `WOVN_TOKEN` bearer secret (the wovn CLI and curl).
- A Cloudflare Access JWT in a cookie, minted by `/login`: the Zero Trust app
  ("wovn login", team `connorchev.cloudflareaccess.com`) is path-scoped to
  `files.wovn.org/login` only. Anonymous requests for anything non-public
  302 to `/login?to=<path>`; Access runs the interactive login there and
  injects the JWT; the worker copies it into a host-wide `wovn_auth` cookie
  and bounces back. All routes verify the JWT themselves (signature, issuer,
  audience, expiry), so a deleted or misconfigured Access app fails closed.
  Private objects and missing keys look identical to anonymous clients (both
  redirect), so probing leaks nothing.

Public objects are served cacheable (stable paths revalidate by etag,
generated keys are immutable); everything else is `private, no-store`.

Deployed on the personal Cloudflare account (connorchev@gmail.com), pinned
via `account_id` in `wrangler.jsonc`.

## Develop and deploy

```sh
pnpm install
pnpm typecheck
pnpm run deploy
```

## The wovn CLI

`../cli` is a TypeScript commander program that wraps the host for agents and
humans: `wovn put <file...>` uploads (private by default; `--public` to
share, `--at` for stable paths, `--force` to replace), tagging each upload
with the git context it ran in; `wovn list` shows recent files with a
`pub`/`prv` column (`--public`/`--private` filter by visibility, `--project`
/ `--branch` / `--worktree` / `--dir` by context, `--type` by file type);
`wovn read` prints a hosted file; `wovn history` lists all versions of a
stable path; `wovn diff` git-diffs two hosted files (one argument = previous
vs current); `wovn visibility get/set` reads and flips visibility;
`wovn rm` deletes a file and its archived history; `wovn token rotate`
rotates the token. Build and install: `pnpm install && pnpm build` in
`../cli`, then `cp ../cli/dist/wovn ~/.local/bin/wovn` (re-run after editing
`../cli/src/wovn.ts`).

## Token rotation

The token lives in two places: the `WOVN_TOKEN` Worker secret (server side)
and `~/.config/wovn-files/token.txt` (client side, exported into the shell
env by `~/.zshenv`). `wovn token rotate` updates both: it sets the Worker
secret first (via npx wrangler, pinned to the personal account), then writes
the token file. Open a new shell if anything relies on the stale `WOVN_TOKEN`
env var; `wovn` itself reads the file and keeps working.
