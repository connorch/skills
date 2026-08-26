# wovn-files

Cloudflare Worker behind `https://files.wovn.org`, the file host used by the
`wovn-file-hosting` skill. One hostname, one R2 bucket (`wovn-files`); every
File is private unless its customMetadata says `visibility: public` (fail
closed), and `archive/` objects - Versions of Stable Paths - are always
private. See `../docs/adr/0001-single-host-fail-closed-visibility.md` for
why, `../docs/adr/0002-natural-path-browsing-rest-api.md` for the URL
resolution and API surface, and `../CONTEXT.md` for the domain language.

## URL resolution

Every GET resolves with one rule: an exact Key match serves the File; any
other path is a Directory Route that renders the browse UI for that prefix.
A trailing slash always means a Directory Route (so `/pr-assets/` is the
listing even if a File named `pr-assets` exists), and bare `/` is the root
listing. Directory Routes are never public: anonymous requests to a private
File, a directory, or nothing at all get the identical `302 /login?to=`, so
probing leaks nothing. Public File URLs serve anonymously as before.

The browse UI (the `../ui` SPA, bundled under the reserved `/_/` prefix via
the Worker's `ASSETS` binding) is served only when the request's `Accept`
header includes `text/html`; authenticated non-HTML clients get a plain 404
on non-matching paths, so `wovn read`, curl, and agents keep error
detection.

`GET /<key>/archive` shows a File's Versions in the UI, and
`GET /<key>/archive/<stamp>` serves that Version; both alias onto the
existing `archive/<key>/<stamp>` storage (always private).

## Uploads

Authenticated uploads write to R2 and return the URL; `POST` mints an
immutable Generated Key (`yyyy/mm/<random>-<name>`); `PUT` writes to the
exact request path, giving a Stable Path for living documents (the CLI maps
`wovn put` to POST and `wovn put --at` to PUT). A `PUT` to an existing Key
is rejected with 409 unless the request carries `x-wovn-force: 1` (the
CLI's `--force`), so paths are never clobbered by accident. A forced
overwrite first copies the old state to `archive/<path>/<stamp>-<random>`
and preserves the path's Visibility unless the request restates it -
updating a published document does not unpublish it.

Reserved Keys reject uploads with a 400 naming the reserved word: top-level
`login`, `_`, `favicon.ico`, `robots.txt`, `.well-known`, `api`, `app`,
`assets`, `static`, `auth`, `logout`, `admin`, `settings`, `upload`,
`search`, `share`, `status`, `health`; and `archive` in any Key segment.

## REST API

Management lives under `/api` (authenticated; anonymous requests get a
plain 401, never the login redirect):

- `GET /api/files` - the collection. `?prefix=&delimiter=/` returns one
  directory level as `{prefix, directories, files}` (browse, name order);
  `?project=&branch=&worktree=&dir=&type=&limit=&visibility=` filters
  recent Files, newest first (list). Filters compose.
- `GET /api/files/<key>` - the File's metadata (size, uploaded, visibility,
  stable, content type, git context).
- `PATCH /api/files/<key>` with `{"visibility": "public"|"private"}` -
  flips the stamp via a metadata self-copy; same Key, same URL.
- `DELETE /api/files/<key>` - removes the File plus its whole
  `archive/<key>/` history (an `archive/...` key deletes one Version) and
  returns the deleted keys.
- `GET /api/versions/<key>` - `{current, versions}` for a Stable Path,
  newest first. Top-level resource because Keys contain slashes.

Content URLs keep only GET (serve) and PUT/POST (upload); the old
`?list` / `?history` / `?visibility` query verbs and content-URL
PATCH/DELETE are gone.

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

Public Files are served cacheable (Stable Paths revalidate by etag,
Generated Keys are immutable); everything else is `private, no-store`.

Deployed on the personal Cloudflare account (connorchev@gmail.com), pinned
via `account_id` in `wrangler.jsonc`.

## Develop and deploy

```sh
# once: build the browse UI (the ASSETS binding points at ../ui/dist)
cd ../ui && pnpm install && pnpm build && cd ../worker

pnpm install
pnpm typecheck
pnpm run deploy
```

## The wovn CLI

`../cli` is a TypeScript commander program that wraps the host for agents and
humans: `wovn put <file...>` uploads (private by default; `--public` to
share, `--at` for Stable Paths, `--force` to replace), tagging each upload
with the git context it ran in; `wovn list` shows recent Files with a
`pub`/`prv` column (`--public`/`--private` filter by Visibility, `--project`
/ `--branch` / `--worktree` / `--dir` by context, `--type` by file type);
`wovn read` prints a hosted File; `wovn history` lists all Versions of a
Stable Path; `wovn diff` git-diffs two hosted Files (one argument = previous
vs current); `wovn visibility get/set` reads and flips Visibility;
`wovn rm` deletes a File and its archived history; `wovn token rotate`
rotates the token. All management commands go through `/api`. Build and
install: `pnpm install && pnpm build` in `../cli`, then
`cp ../cli/dist/wovn ~/.local/bin/wovn` (re-run after editing
`../cli/src/wovn.ts`; a wovn binary older than the `/api` surface fails on
`list`/`history`/`diff`/`visibility`/`rm` - `put` and `read` keep working).

## Token rotation

The token lives in two places: the `WOVN_TOKEN` Worker secret (server side)
and `~/.config/wovn-files/token.txt` (client side, exported into the shell
env by `~/.zshenv`). `wovn token rotate` updates both: it sets the Worker
secret first (via npx wrangler, pinned to the personal account), then writes
the token file. Open a new shell if anything relies on the stale `WOVN_TOKEN`
env var; `wovn` itself reads the file and keeps working.
