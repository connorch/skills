---
name: jev
description: Use when the user asks to use Jev or Kev, when a task needs bulk classification, yes/no filtering, or scoring of many items, or when browser work is repetitive or high-volume (many searches, collecting results across pages). Jev is TypeSafe's fast decision model and drives the jevx CLI and the Agents Chrome on this Machine. For one-off browsing, use your usual browser tools unless the user asks for Jev.
metadata:
  agents: [claude-code, codex, openclaw]
  platforms: [darwin]
  machines: [connors-mac-studio]
  requires: "the jevx CLI (apps/jevx-cli), a jev-ultrafast clone at ~/Projects/jev-ultrafast, Ollama with gemma4:26b, and Chrome with remote debugging enabled"
---

# Jev

Jev is a decision model: a state plus typed questions (choice, noul, score) in,
calibrated probabilities out, in tens of milliseconds. It never generates text,
plans, or knows much trivia. Use it where code needs judgments at volume or
inside a loop; keep planning, text generation, and final verification yourself.
For question design and the API, use the `typesafe-ai` skill.

If the user says "Kev", use Jev. Kev (an open-source clone of Jev) is not set up.

## The jevx CLI

```sh
jevx classify --options sandwich,soup,salad --in foods.txt --out foods.jsonl
jevx classify --options "bug=Something is broken,feature=A request for new behavior" < issues.txt
jevx browse --url https://en.wikipedia.org --goal "Open the article about the Mandelbrot set"
jevx harness <<'PY'
new_tab("https://example.com")
print(page_info())
PY
```

- `classify`: one Choice per input line, concurrent. JSONL rows
  (`item`, `choice`, `confidence`, `probabilities`); counts and rows below
  `--low` (default 0.5) go to stderr. Review uncertain rows yourself.
- `browse`: jev-ultrafast. Jev picks each click, selection, and scroll; a local
  model (gemma4:26b in Ollama) writes typed values. Prints JSON: `status`,
  `steps`, final `url`, `page_text`. `--keep-open` leaves the tab for follow-up
  `jevx harness` scripting.
- `harness`: browser-harness, Python snippets with helpers pre-imported
  (`new_tab`, `goto_url`, `page_info`, `js`, `fill_input`, `click_at_xy`,
  `press_key`, `wait_for_element`, `capture_screenshot`, ...). Run
  `jevx harness skill` for its full guide.

For judgments `classify` does not cover (nouls, scores, several questions per
item), write a TypeScript script with `@typesafe-ai/sdk`. The key is in
`~/.config/typesafe/api_key.txt` and `TYPESAFE_API_KEY`. Ask every question about
the same state in one request.

## The browser

`browse` and `harness` drive the user's Agents Chrome (the default Chrome, with
the Claude and Codex extensions) through one shared browser-harness connection.
Never launch another browser, and never connect to this Chrome with Playwright,
Puppeteer, or raw CDP: each new connection makes Chrome ask the user to "Allow
remote debugging". The shared connection asks once, usually after Chrome
restarts; if a command waits on that, tell the user to click Allow.

- Never buy, pay, submit orders, change account or DNS settings, or send
  messages unless the user explicitly asked for that exact action. Searching and
  reading are fine.
- If a site needs a login, stop and ask the user to log in in the Agents Chrome.
- A `done` status is not proof. Check `page_text` for the requested outcome.
- Work in your own tabs; do not close tabs you did not open.

## Choosing the approach

- **One navigation goal** ("find X", "open Y"): `jevx browse` with one narrow goal.
- **Repeated or bulk browser work** (many searches, collecting results): do not
  run `jevx browse` hundreds of times. Learn the flow once (`jevx browse --keep-open`,
  then inspect with `jevx harness`), then write one `jevx harness` script that
  loops in code: generate inputs, read results with `js(...)`, write them to a
  file. Use Jev for the fuzzy judgments (for example, a `jevx classify` pass over
  the candidates).
- **Bulk classification or filtering**: `jevx classify`.

## Limits

- `browse` handles common HTML and ARIA controls. Iframes, shadow DOM, canvas,
  uploads, pop-up tabs, and nested scrolling are out of scope; use `jevx harness`.
- Knowledge questions are weaker than a frontier LLM. Put the facts in the state.
- No headless mode: everything runs in the visible Agents Chrome.
