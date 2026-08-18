---
name: wovn-file-hosting
description: Use when a local file needs a public or private URL, or when the user asks to upload, host, share, list, or retrieve files through Wovn.
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
  requires: "the wovn CLI on PATH, or FILE_HOST_TOKEN in the environment"
---

# Wovn file hosting

Upload files to `https://files.wovn.org` and return the permanent public URL
from the response body. Prefer the `wovn` CLI:

```sh
wovn put /path/to/screenshot.png
wovn put --name pr-142-upload-flow-after.png "/tmp/Screenshot 2026-08-11 at 3.14.15 PM.png"
```

If `wovn` is not on the PATH, fall back to curl with `FILE_HOST_TOKEN`
(`-X POST` matters: POST mints an immutable URL, PUT overwrites a stable path):

```sh
file="/path/to/screenshot.png"
curl -sS -X POST -T "$file" \
  -H "Authorization: Bearer $FILE_HOST_TOKEN" \
  "https://files.wovn.org/$(basename "$file" | tr ' ' '-')"
```

If neither the CLI nor the token is available, tell the user instead of
guessing.

The response body is the URL, nothing else. Files are keyed by date plus a
random slug, so uploading never overwrites anything and URLs are permanent.
Content types are inferred from the file extension, so images and videos
render inline in browsers.

## Stable URLs

`wovn put --at <remote-path> <file>` writes to that exact path instead of a
generated key - the URL never changes. If the path is already taken the upload
is rejected; pass `--force` to replace it in place. Use it for living
documents (plans, reports, mocks) that get updated across iterations; use
plain `wovn put` for everything else.

```sh
wovn put --private --at docs/q3-roadmap.html /tmp/q3-roadmap.html
wovn put --private --at docs/q3-roadmap.html --force /tmp/q3-roadmap.html  # update in place
```

## Version history

Overwriting a stable path never destroys anything: the worker first copies
the old version to `archive/<path>/<timestamp>`, a permanent immutable URL of
its own. The `archive/` prefix is reserved (`--at` cannot write there), and
archived versions never appear in `wovn list` - only in per-path history.

`wovn history <path-or-url>` prints every version of a stable path, newest
first, with the current one marked. `wovn diff` fetches two versions and runs
`git diff` on them; with a single argument it compares a stable path's
previous version against its current one - "what changed in the last
update?". Bare paths refer to the private host, like `wovn read`.

```sh
wovn history docs/q3-roadmap.html
wovn diff docs/q3-roadmap.html                  # previous vs current
wovn diff <old-url-or-path> <new-url-or-path>   # any two versions
```

## Listing recent files

`wovn list` prints recent uploads across both hosts, newest first, one line
per file (timestamp, size, URL). `--public` / `--private` restrict to one
host; `-n <count>` changes the limit (default 20). Listing is authenticated
on both hosts - public URLs are unguessable, so the listing itself is never
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

## Private uploads

`wovn put --private <file>` uploads to `https://private.wovn.org`, gated by
Cloudflare Access: only Connor can read the URLs (browser login as
connorchev@gmail.com, or the CLI's service token). Use it for plans, internal
notes, and anything that should not be public. Never embed private URLs in
public PRs or issues - other people cannot open them.

To read a private file back (for example a previously uploaded plan), use
`wovn read <url>`; a bare path like `docs/plan.html` also works and reads
from the private host. Without the CLI, curl with the service token creds:

```sh
. ~/.config/wovn-files/access.env
curl -sS -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" "$url"
```

## Embedding on GitHub

- Images: `![description](url)` renders inline in PRs, issues, and comments.
- Videos: GitHub only plays videos uploaded to its own CDN. Post externally
  hosted videos as a plain link, or convert short clips to GIF first if
  inline playback matters.

## Maintenance

The file host is a Cloudflare Worker whose source lives in `worker/` next to
this file (R2 bucket `wovn-files`, token stored as a Worker secret). To change
it, edit `worker/src/index.ts` and run `pnpm typecheck && pnpm run deploy` there.

The `wovn` CLI is a TypeScript commander program in `cli/`; after editing
`cli/src/wovn.ts`, run `pnpm install && pnpm typecheck && pnpm build` there
and install the bundle with `cp dist/wovn ~/.local/bin/wovn`.
