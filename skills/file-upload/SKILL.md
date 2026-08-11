---
name: file-upload
description: Upload any local file - a screenshot, screen recording, log, document, markdown file, config, build artifact, or archive - to Connor's public file host at files.wovn.org and return a permanent public URL. Use whenever a public link to a local file is needed, including for GitHub pull requests, issues, and messages, for sharing a doc or config with another person or agent, or whenever the user says "upload it", "host this", "put this somewhere I can link", or "use the file skill".
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
  scope: fleet
  requires: "FILE_HOST_TOKEN in the environment"
---

# File upload

Upload files to `https://files.wovn.org` and return the permanent public URL
from the response body. Authenticate with `FILE_HOST_TOKEN`. If it is unset,
tell the user instead of guessing.

```sh
file="/path/to/screenshot.png"
curl -sS -T "$file" \
  -H "Authorization: Bearer $FILE_HOST_TOKEN" \
  "https://files.wovn.org/$(basename "$file" | tr ' ' '-')"
```

The response body is the URL, nothing else. Files are keyed by date plus a
random slug, so uploading never overwrites anything and URLs are permanent.
Content types are inferred from the file extension, so images and videos
render inline in browsers.

## Embedding on GitHub

- Images: `![description](url)` renders inline in PRs, issues, and comments.
- Videos: GitHub only plays videos uploaded to its own CDN. Post externally
  hosted videos as a plain link, or convert short clips to GIF first if
  inline playback matters.

## Maintenance

The file host is a Cloudflare Worker whose source lives in `worker/` next to
this file (R2 bucket `wovn-files`, token stored as a Worker secret). To change
it, edit `worker/src/index.ts` and run `pnpm typecheck && pnpm run deploy` there.
