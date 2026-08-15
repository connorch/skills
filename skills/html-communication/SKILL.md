---
name: html-communication
description: When the user asks for an HTML writeup of work (NOT as part of the codebase), use this skill to create it and always publish it privately with the wovn-file-hosting skill's wovn CLI. Also useful for reading private.wovn.org URLs back.
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
  requires: "the wovn CLI on PATH (see the wovn-file-hosting skill)"
---

# HTML Communication

## When to Use

Use this skill when the user wants a plan, spec, write-up, findings, summary,
report, comparison, or set of UI mocks presented as readable HTML.

Do not use it for HTML that ships as part of a product.

## Document

Create one self-contained HTML file, capped at 1MB.

- Write it like a spec, not a landing page: yes dense, yes scannable, no hero,
  no decorative chrome, no marketing voice, and no em dashes.
- Talk in ASD-STE100 Simplified Technical English, and use the ubiquitous language from `CONTEXT.md` if one exists.
- Make it mobile-readable with a responsive viewport and no fixed-width layout.
- Use semantic HTML, inline CSS, inline SVG, and HTTPS or data-URL images.
- Use diagrams, charts, or visualizations when you think it will actually be useful to the user. Connor is a visual learner.
- Use an inline classic script only when interactivity materially helps. Keep
  scripted pages useful without JavaScript; the sandbox blocks storage, fetch,
  workers, frames, forms, and popups.
- In script-free files, give external links `target="_blank"` and
  `rel="noopener noreferrer"`. If any script exists, omit `target="_blank"`.

Never include external or module scripts, inline event handlers, `javascript:`
URLs, forms, frames, embeds, objects, applets, meta refresh, linked stylesheets,
secrets, private URLs, or local filesystem paths.

### Palette

This palette is a suggestion. Use unless you have a need or are asked to deviate.

```
--bg:        #121212   page background
--surface:   #1E1E1E   cards, code blocks, table header rows. Go slightly lighter for each level of elevation.
--text:      #E0E0E0   body copy and headings
--muted:     #A0A0A0   labels, captions, metadata
--border:    #2A2A2A   dividers and hairlines
--accent:    #90CAF9   links and emphasis
--success:   #A5D6A7   positive status indicator (passed, added, etc.)
--danger:    #CF6679   negative status indicator (blocked, failed, removed, etc.)
```

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

1. Write the HTML file locally, named per the wovn-file-hosting skill's naming
   convention (kebab-case, descriptive, `.html`).
2. Run `wovn put --private --at docs/<file name> <file path>` (add `--force`
   when updating a document that is already published).
3. Report the local path and the returned private.wovn.org URL.

Re-upload to the same `--at` path with `--force` to update the document in
place; the URL stays stable across iterations. Use a new path only for a
genuinely new document. Only Connor can open private.wovn.org URLs (browser login or the
CLI's service token); never embed them in public PRs or issues. To read one
back, run `wovn read <url>`.

If `wovn` or its Access credentials are missing, tell the user instead of
guessing. Never claim the document is hosted before the upload succeeds. Do
not verify in a browser unless the user asks.
