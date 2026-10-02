---
name: t3-browser
description: Use for any browser QA, verification, screenshot, or "check it in the browser" step when the T3 Code Browser panel tools (mcp__t3-code__preview_*, such as preview_status and preview_snapshot) are available. Drives the Browser panel the user watches live, in place of the repo's own browser automation.
metadata:
  requires: "T3 Code's preview_* tools"
---

# T3 Browser panel

T3 Code has a built-in Browser panel, and the user watches it while you work.
When its `preview_*` tools are available, use them for browser work instead
of a headless browser or the repo's own automation.

- **Flow.** Call `preview_status`, then `preview_open` if the panel is
  closed. Navigate with `preview_navigate`, then inspect with
  `preview_snapshot` before acting. Interact with Playwright role/text
  locators, such as `role=button[name='Save']` or `text=Continue`, through
  `preview_click`, `preview_type` (`clear: true` replaces), `preview_press`,
  and `preview_wait_for`. Omit `tabId` so every call reuses this session's
  tab, and do not open new tabs. Snapshot text is capped near 20 KB; read
  more with `preview_evaluate`.
- **Screenshots.** The image in a snapshot result is not saved anywhere. To
  show the user one, call `preview_snapshot` with `save: true` and embed the
  returned `screenshotPath` in the reply as `![alt](screenshotPath)`.
- **Reaching dev servers.** The browser runs on the machine the user views
  T3 Code from, which may not be the machine running the code, so
  `http://localhost:<port>` can point at the wrong host. For a local dev
  server, navigate with
  `preview_navigate({ target: { kind: "environment-port", port, path } })`
  (`path` optional, such as `"/settings"`). For this to work from another
  machine, the dev server must listen on all interfaces; the repo's docs
  usually say how, often a `--host` flag.
- **Repo specifics.** For app URLs, ports, test accounts, and sign-in steps,
  follow the current repo's browser automation docs, and skip only their
  tool-specific commands. The panel keeps its logins between uses, so snapshot
  first and sign in only if the app is not already signed in. Keep
  credentials out of replies and screenshots.
- **Fallback.** If the `preview_*` tools are unavailable or the panel
  reports it is unavailable, say so and use the repo's documented browser
  automation.
