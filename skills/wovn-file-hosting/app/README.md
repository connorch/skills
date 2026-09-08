# wovn-files

The TanStack Start app behind `https://files.wovn.org`, running on a
Cloudflare Worker: the file host used by the `wovn-file-hosting` skill and
the browser surface around it. One hostname, one R2 bucket (`wovn-files`);
every File is private unless its customMetadata says `visibility: public`
(fail closed), and `archive/` objects - Versions of Stable Paths - are always
private. See `../docs/adr/0001` for why, `0002` for URL resolution and the
API, `0003` for the Banner and the one wrap rule, `0004` for the Start
layout, and `../CONTEXT.md` for the domain language.

## Layout

```
src/server.ts          the Worker entry: the file host runs first, Start only
                       sees authenticated app pages (ADR 0004)
src/host/*.server.ts   auth, R2 data functions, /api, URL resolution, and the
                       Banner injection for HTML Files
src/routes/            __root.tsx (shell) and $.tsx (every app page)
src/banner/            the Banner: strip, panel, tabs, visibility select, and
                       the two mounts (page-view.tsx, app.tsx)
src/banner.tsx         the module that hydrates the injected Banner
src/components/        listing, search palette, previews, shadcn ui/
src/lib/               types, /api client, React Query definitions
vite.config.ts         Start + Cloudflare + Tailwind; assets under /_/
vite.banner.config.ts  the second build: src/banner.tsx -> /_/banner.js
wrangler.jsonc         main is src/server.ts; assets from the Vite output
```

## URL resolution

Every GET resolves with one rule: an exact Key match names the File; any
other path is a Directory Route. A trailing slash always means a Directory
Route (so `/pr-assets/` is the listing even if a File named `pr-assets`
exists), and bare `/` is the root listing. Directory Routes are never
public: anonymous requests to a private File, a directory, or nothing at all
get the identical `302 /login?to=`, so probing leaks nothing. Public File
URLs serve anonymously as before.

What a request gets depends on one more thing (ADR 0003): an authenticated
Document Navigation (`Sec-Fetch-Dest: document`, no `?raw`) gets the app.
An HTML File is streamed through HTMLRewriter with the Banner injected into
its `<body>` as declarative Shadow DOM; every other File renders as an app
page with the Banner over a Preview of `/<key>?raw`; a Directory Route
renders the listing. Everything else - subresource loads, downloads, fetch,
curl, `wovn read`, and every anonymous request - gets Raw: the stored bytes
and headers, with `Vary: Sec-Fetch-Dest, Cookie` added. An authenticated
non-document GET of a path with no Key stays a plain 404.

Versions have three URL spellings for the same object: the storage Key
`archive/<key>/<stamp>`, the alias `/<key>/archive/<stamp>`, and
`/<key>?version=<stamp>`. Raw serves all three; a Document Navigation to
either path form 302s to the query form, so the File's own path stays the
document base URL. `/<key>/archive` 302s to `/<key>?versions`, which opens
the Banner's versions tab.

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

The Banner and the app pages use this same API from the browser; there are
no server functions.

## Auth

Two interchangeable credentials, accepted on every route:

- The `WOVN_TOKEN` bearer secret (the wovn CLI and curl).
- A Cloudflare Access JWT in a cookie, minted by `/login`: the Zero Trust app
  ("wovn login", team `connorchev.cloudflareaccess.com`) is path-scoped to
  `files.wovn.org/login` only. Anonymous requests for anything non-public
  302 to `/login?to=<path and query>`; Access runs the interactive login
  there and injects the JWT; the host copies it into a host-wide `wovn_auth`
  cookie and bounces back. All routes verify the JWT themselves (signature,
  issuer, audience, expiry), so a deleted or misconfigured Access app fails
  closed.

Public Files are served cacheable (Stable Paths revalidate by etag,
Generated Keys are immutable); Raw private responses, app pages, and
injected HTML are `private, no-store`.

Deployed on the personal Cloudflare account (connorchev@gmail.com), pinned
via `account_id` in `wrangler.jsonc`.

## Develop, verify, deploy

```sh
pnpm install
pnpm dev          # app pages (Directory Routes, Previews) with HMR
pnpm typecheck    # wrangler types && tsc
pnpm lint
pnpm build        # the Start build, then the Banner bundle
pnpm preview      # the built Worker in workerd with a local bucket
pnpm run deploy   # build + wrangler deploy
```

The injected Banner has no dev mode (ADR 0004): check it through
`pnpm build && pnpm preview`. Put the bearer token in `.dev.vars`
(`WOVN_TOKEN=...`, gitignored) and seed the local bucket with the CLI
pointed at the preview: `WOVN_HOST=http://localhost:4173 wovn put ...`.
For browser checks, open the preview with an injected
`Authorization: Bearer` header (agent-browser's `--headers`), since the
`/login` flow needs the real Access app in front.

## The wovn CLI

`../cli` is a TypeScript commander program that wraps the host for agents and
humans: `wovn put <file...>` uploads (private by default; `--public` to
share, `--at` for Stable Paths, `--force` to replace), tagging each upload
with the git context it ran in; `wovn list` shows recent Files with a
`pub`/`prv` column (`--public`/`--private` filter by Visibility, `--project`
/ `--branch` / `--worktree` / `--dir` by context, `--type` by file type);
`wovn read` prints a hosted File; `wovn open` opens one in the browser;
`wovn history` lists all Versions of a Stable Path; `wovn diff` git-diffs two
hosted Files (one argument = previous vs current); `wovn visibility get/set`
reads and flips Visibility; `wovn rm` deletes a File and its archived
history; `wovn token rotate` rotates the token. All management commands go
through `/api`. Build and install: `pnpm install && pnpm build` in `../cli`,
then `cp ../cli/dist/wovn ~/.local/bin/wovn` (re-run after editing
`../cli/src/wovn.ts`).

## Token rotation

The token lives in two places: the `WOVN_TOKEN` Worker secret (server side)
and `~/.config/wovn-files/token.txt` (client side, exported into the shell
env by `~/.zshenv`). `wovn token rotate` updates both: it sets the Worker
secret first (via npx wrangler, pinned to the personal account), then writes
the token file. Open a new shell if anything relies on the stale `WOVN_TOKEN`
env var; `wovn` itself reads the file and keeps working.
