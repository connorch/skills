---
name: wovn-file-hosting
description: Upload any local file - a screenshot, screen recording, log, document, markdown file, config, build artifact, or archive - to Connor's file host and return a permanent URL. Public uploads go to files.wovn.org for embedding in GitHub pull requests, issues, and messages or sharing with other people and agents; private uploads go to private.wovn.org (readable only by Connor) for plans, internal notes, and anything not meant to be public. Use whenever a link to a local file is needed, whenever the user says "upload it", "host this", "put this somewhere I can link", or "use the file skill", or when the user asks to upload or host something privately or internally.
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
