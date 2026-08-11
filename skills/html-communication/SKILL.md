---
name: html-communication
description: When the user asks for an HTML writeup of work (NOT as part of the codebase), use this skill to create it and always publish it privately with the file-upload skill's wovn CLI. Also useful for reading private.wovn.org URLs back.
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
  scope: fleet
  requires: "the wovn CLI on PATH (see the file-upload skill)"
---

# HTML Communication

## When to Use

Use this skill when the user wants a plan, spec, write-up, findings, summary,
report, comparison, or set of UI mocks presented as readable HTML.

Do not use it for HTML that ships as part of a product.

## Document

Create one self-contained HTML file, capped at 512 KB.

- Write it like a spec, not a landing page: dense, scannable, no hero,
  decorative chrome, marketing voice, or em dashes.
- Default to true black (`#000`), white primary text, and dark gray only for
  secondary surfaces or accents.
- Make it mobile-readable with a responsive viewport and no fixed-width layout.
- Use semantic HTML, inline CSS, inline SVG, and HTTPS or data-URL images.
- Use an inline classic script only when interactivity materially helps. Keep
  scripted pages useful without JavaScript; the sandbox blocks storage, fetch,
  workers, frames, forms, and popups.
- In script-free files, give external links `target="_blank"` and
  `rel="noopener noreferrer"`. If any script exists, omit `target="_blank"`.

Never include external or module scripts, inline event handlers, `javascript:`
URLs, forms, frames, embeds, objects, applets, meta refresh, linked stylesheets,
secrets, private URLs, or local filesystem paths.

## UI Mocks

When the user asks for variants:

- Render real styled variants, not descriptions.
- Label them `A`, `B`, `C`... for easy selection.
- Lay them out for direct comparison.
- Keep one file across iterations and publish to the same `--at` path so its
  URL stays stable.

## Publish

Connor has given standing permission to upload every artifact created or updated
with this skill. Upload is required, including in Auto mode. Do not ask for
separate permission or stop at the local file.

1. Write the HTML file locally, named per the file-upload skill's naming
   convention (kebab-case, descriptive, `.html`).
2. Run `wovn put --private --at docs/<file name> <file path>`.
3. Report the local path and the returned private.wovn.org URL.

Re-upload to the same `--at` path to update the document in place; the URL
stays stable across iterations. Use a new path only for a genuinely new
document. Only Connor can open private.wovn.org URLs (browser login or the
CLI's service token); never embed them in public PRs or issues. To read one
back, use the read-back snippet in the file-upload skill.

If `wovn` or its Access credentials are missing, tell the user instead of
guessing. Never claim the document is hosted before the upload succeeds. Do
not verify in a browser unless the user asks.
