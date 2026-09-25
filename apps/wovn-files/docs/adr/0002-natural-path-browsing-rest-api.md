# Natural-path browsing, REST management API

With one hostname and fail-closed per-object visibility (ADR 0001), we added a
browse UI. Rather than carving a UI namespace (`/_/`), every URL resolves with
one rule: an exact Key match serves the File; any other path is a Directory
Route that renders the browse UI for that prefix. Machine endpoints moved from
query-param verbs to a REST surface under the reserved `api/` prefix.

## Directory Routes

- Exact Key match always wins and serves the File, byte-for-byte as before.
- No exact match: the path is a Directory Route; the worker serves the browse
  UI, which lists the Files under `<path>/`. A trailing slash always means a
  Directory Route, which disambiguates a File named `pr-assets` shadowing the
  `pr-assets/` prefix. Bare `/` is the root Directory Route.
- Directory Routes are never public, regardless of the visibility of Files
  inside: anonymous requests get the same `302 /login?to=` as private or
  nonexistent Files, so file, private file, directory, and nothing remain
  indistinguishable to probes. Public File URLs still serve anonymously.
- The browse UI is served only to clients whose `Accept` header includes
  `text/html`. An authenticated non-HTML GET of a path with no exact Key
  match stays a plain 404, so scripted reads (`wovn read`, curl, agents)
  keep error detection instead of receiving a 200 HTML shell. Anonymous
  requests get the login redirect regardless of Accept.

## Reserved Keys

Uploads are rejected (400, message naming the word) for top-level segments:
`login`, `_` (SPA asset bundle), `favicon.ico`, `robots.txt`, `.well-known`,
and speculative future surfaces `api`, `app`, `assets`, `static`, `auth`,
`logout`, `admin`, `settings`, `upload`, `search`, `share`, `status`,
`health`. We chose to over-reserve deliberately: permanent URLs make a later
collision between a claimed Key and a new system route expensive, while
reserving a name Connor never uploads to costs nothing. `archive` is reserved
in ANY Key segment (not just top-level) so the Version alias routes below can
never be shadowed.

## Version URLs are aliases, storage is unchanged

`GET /<key>/archive` shows a File's Versions in the UI;
`GET /<key>/archive/<stamp>` serves that Version. Both are route aliases onto
the existing `archive/<key>/<stamp>` storage layout. We rejected migrating
storage to the suffix layout because delimited listing would then show a
phantom `<file>/` folder next to every stable File with history, polluting
exactly the natural browsing this exists for. Old `archive/...` URLs keep
working because they are real Keys (and remain always-private).

## REST API under /api, query verbs deleted

`?list`, `?history`, and `?visibility` are gone (the CLI was their only
consumer and migrated in the same change). The surface:

- `GET /api/files` - the collection. `?prefix=&delimiter=/` returns one
  directory level (browse); `?project=&branch=&worktree=&dir=&type=&limit=`
  returns the recent-files query (list). Filters compose.
- `GET|PATCH|DELETE /api/files/<key>` - metadata, visibility flip
  (`{"visibility": "public"}`), delete (including the File's Versions).
- `GET /api/versions/<key>` - a File's Versions, newest first.

Anonymous `/api` requests get a plain 401, not the login redirect: `/api` is
a reserved machine surface whose existence is not secret, and a 302 to an
HTML login page confuses API clients.

Versions are a top-level resource instead of `/api/files/<key>/versions`
because Keys contain slashes: with a sub-resource suffix, the key/suffix
boundary is unparseable. One resource segment up front keeps "everything
after it is the Key" true everywhere. DELETE moved off the content URL so the
split is clean: content URLs serve and publish (GET, PUT, POST); `/api` is
all management.
