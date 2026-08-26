---
name: wovn-file-hosting
description: Use when a local file needs a public or private URL, or when the user asks to upload, host, share, list, or retrieve files through Wovn.
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
  requires: "the wovn CLI on PATH, or WOVN_TOKEN in the environment"
---

# Wovn file hosting

Upload files to `https://files.wovn.org` and return the permanent URL from the
response body. Files are **private by default** - only Connor can open them
(browser login, or the CLI's token). Pass `--public` only when the URL must be
readable by others (PR screenshots, images embedded on GitHub, anything
shared externally). Prefer the `wovn` CLI:

```sh
wovn put /path/to/plan.html                     # private (default)
wovn put --public pr-142-upload-flow-after.png  # public, for sharing
wovn put --public --name pr-142-after.png "/tmp/Screenshot 2026-08-11 at 3.14.15 PM.png"
```

If `wovn` is not on the PATH, fall back to curl with `WOVN_TOKEN`
(`-X POST` matters: POST mints an immutable URL, PUT overwrites a stable
path; add `-H "x-wovn-visibility: public"` for a public upload):

```sh
file="/path/to/screenshot.png"
curl -sS -X POST -T "$file" \
  -H "Authorization: Bearer $WOVN_TOKEN" \
  "https://files.wovn.org/$(basename "$file" | tr ' ' '-')"
```

If neither the CLI nor the token is available, tell the user instead of
guessing.

The response body is the URL, nothing else. Generated keys are dated plus a
random slug, so uploading never overwrites anything, URLs never change, and a
URL is never reused; files exist until explicitly deleted with `wovn rm`.
Content types are inferred from the file extension, so images and videos
render inline in browsers.

## Public vs private

Every file carries its own visibility; there is one host and one URL per
file, and flipping visibility never changes the URL. A private URL opened in
a browser bounces through `files.wovn.org/login` (Cloudflare Access); other
people cannot open it - never embed a private URL in a public PR or issue.

```sh
wovn visibility get docs/q3-roadmap.html         # public | private
wovn visibility set docs/q3-roadmap.html public  # publish; URL unchanged
wovn visibility set docs/q3-roadmap.html private # unpublish (best effort:
                                                 # caches/readers may have seen it)
```

Reading a private file back (for example a previously uploaded plan):
`wovn read <url-or-path>`; bare paths like `docs/plan.html` work everywhere a
URL does. Without the CLI: `curl -H "Authorization: Bearer $WOVN_TOKEN" <url>`.

## Stable URLs

`wovn put --at <remote-path> <file>` writes to that exact path instead of a
generated key - the URL never changes. If the path is already taken the upload
is rejected; pass `--force` to replace it in place. Use it for living
documents (plans, reports, mocks) that get updated across iterations; use
plain `wovn put` for everything else. Updating a published document keeps it
public - visibility belongs to the path and only changes via
`wovn visibility set` or an explicit `--public`/`--private` on the upload.

```sh
wovn put --at docs/q3-roadmap.html /tmp/q3-roadmap.html
wovn put --at docs/q3-roadmap.html --force /tmp/q3-roadmap.html  # update in place
```

## Version history

Overwriting a stable path never destroys anything: the worker first copies
the old version to `archive/<path>/<timestamp>`, a permanent URL of its own.
Archived versions are **always private**, even for public documents; the
`archive/` prefix is reserved (`--at` cannot write there) and hidden from
`wovn list` - only per-path history shows it.

`wovn history <path-or-url>` prints every version of a stable path, newest
first, with the current one marked. `wovn diff` fetches two versions and runs
`git diff` on them; with a single argument it compares a stable path's
previous version against its current one - "what changed in the last
update?".

```sh
wovn history docs/q3-roadmap.html
wovn diff docs/q3-roadmap.html                  # previous vs current
wovn diff <old-url-or-path> <new-url-or-path>   # any two versions
```

## Deleting

`wovn rm <path-or-url>` deletes a file permanently - and for a stable path,
its entire archived history too, so nothing lingers. Passing a specific
archive URL prunes just that version. It prints every key it deleted.

```sh
wovn rm docs/old-plan.html
```

## Listing recent files

`wovn list` prints recent uploads, newest first, one line per file
(timestamp, size, `pub`/`prv`, URL). `--public` / `--private` filter by
visibility; `-n <count>` changes the limit (default 20). Listing is
authenticated - public URLs are unguessable, so the listing itself is never
open.

```sh
wovn list
wovn list --private -n 50
```

## Filtering by git context

Every `wovn put` automatically tags the upload with the environment it ran
in: the working directory, and (when inside a git repo) the branch, the
worktree root, and the project - the main checkout the worktree was created
off of. Nothing needs to be passed at upload time.

`wovn list` filters on those tags with `--project`, `--branch`, `--worktree`,
and `--dir`. Each takes an optional value; a bare flag means "the current
one", inferred the same way uploads are tagged:

```sh
wovn list --branch                    # uploads made from the branch I'm on now
wovn list --project                   # uploads from this project, any worktree/branch
wovn list --project skills            # by project name (or full path)
wovn list --branch main --private     # explicit values combine with other flags
```

`--project` matches the project name or its full path; `--worktree` and
`--dir` match exact paths. Files uploaded before tagging existed, or via the
curl fallback, carry no context and never match a filter.

## Filtering by file type

`wovn list --type` narrows the listing to a file type, matched on the
extension in the URL. Values are either a category - `image`, `video`,
`document`, `data`, `archive` - or a bare extension, and can be
comma-separated or repeated:

```sh
wovn list --type image                 # png, jpg, jpeg, gif, webp, svg
wovn list --type document              # pdf, doc, docx, odt, rtf, md, html, txt, log
wovn list --type pdf,png               # exact extensions
wovn list --type image --private -n 50
```

The filter runs before the limit, so `--type pdf -n 20` means the 20 newest
PDFs rather than the PDFs among the 20 newest files. Files whose URL has no
extension never match.

## File naming

The filename survives into the permanent URL, so rename files before
uploading: lowercase kebab-case, describe the content and its context, keep
the real extension. Characters outside `a-z A-Z 0-9 . _ -` are replaced with
`-` server-side.

- `pr-142-upload-flow-after.png`, not `Screenshot 2026-08-11 at 3.14.15 PM.png`
- `ci-typecheck-failure.log`, not `output.log`

## Embedding on GitHub

- Only `--public` URLs work for other people. Images: `![description](url)`
  renders inline in PRs, issues, and comments.
- Videos: GitHub only plays videos uploaded to its own CDN. Post externally
  hosted videos as a plain link, or convert short clips to GIF first if
  inline playback matters.

## Maintenance

The file host is a Cloudflare Worker whose source lives in `worker/` next to
this file (single R2 bucket `wovn-files`; the `WOVN_TOKEN` secret and the
`files.wovn.org/login` Cloudflare Access app handle auth - see
`docs/adr/0001`). To change it, edit `worker/src/index.ts` and run
`pnpm typecheck && pnpm run deploy` there. Deploys bundle the browse UI from
`ui/dist`, so run `pnpm install && pnpm build` in `ui/` first on a fresh
checkout. `wovn token rotate` rotates the token (Worker secret +
`~/.config/wovn-files/token.txt`).

The `wovn` CLI is a TypeScript commander program in `cli/`; after editing
`cli/src/wovn.ts`, run `pnpm install && pnpm typecheck && pnpm build` there
and install the bundle with `cp dist/wovn ~/.local/bin/wovn`.
