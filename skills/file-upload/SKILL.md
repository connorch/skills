---
name: file-upload
description: Upload any local file - a screenshot, screen recording, log, document, markdown file, config, build artifact, or archive - to Connor's public file host at files.wovn.org and return a permanent public URL. Use whenever a public link to a local file is needed, including for GitHub pull requests, issues, and messages, for sharing a doc or config with another person or agent, or whenever the user says "upload it", "host this", "put this somewhere I can link", or "use the file skill".
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
  scope: fleet
  requires: "the wovn CLI on PATH, or FILE_HOST_TOKEN in the environment"
---

# File upload

Upload files to `https://files.wovn.org` and return the permanent public URL
from the response body. Prefer the `wovn` CLI:

```sh
wovn put /path/to/screenshot.png
wovn put --name pr-142-upload-flow-after.png "/tmp/Screenshot 2026-08-11 at 3.14.15 PM.png"
```

If `wovn` is not on the PATH, fall back to curl with `FILE_HOST_TOKEN`:

```sh
file="/path/to/screenshot.png"
curl -sS -T "$file" \
  -H "Authorization: Bearer $FILE_HOST_TOKEN" \
  "https://files.wovn.org/$(basename "$file" | tr ' ' '-')"
```

If neither the CLI nor the token is available, tell the user instead of
guessing.

The response body is the URL, nothing else. Files are keyed by date plus a
random slug, so uploading never overwrites anything and URLs are permanent.
Content types are inferred from the file extension, so images and videos
render inline in browsers.

## File naming

The filename survives into the permanent URL, so rename files before
uploading: lowercase kebab-case, describe the content and its context, keep
the real extension. Characters outside `a-z A-Z 0-9 . _ -` are replaced with
`-` server-side.

- `pr-142-upload-flow-after.png`, not `Screenshot 2026-08-11 at 3.14.15 PM.png`
- `ci-typecheck-failure.log`, not `output.log`

## Embedding on GitHub

- Images: `![description](url)` renders inline in PRs, issues, and comments.
- Videos: GitHub only plays videos uploaded to its own CDN. Post externally
  hosted videos as a plain link, or convert short clips to GIF first if
  inline playback matters.

## Maintenance

The file host is a Cloudflare Worker whose source lives in `worker/` next to
this file (R2 bucket `wovn-files`, token stored as a Worker secret). To change
it, edit `worker/src/index.ts` and run `pnpm typecheck && pnpm run deploy` there.

The `wovn` CLI source lives in `bin/wovn` and is installed by copy; after
editing it, run `cp bin/wovn ~/.local/bin/wovn`.
