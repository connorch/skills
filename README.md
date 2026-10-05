# Agent Skills

A collection of agent skills that extend capabilities across planning, development, and tooling.

## Installation

Install all skills from the repository's `main` branch:

```sh
skills add connorch/skills --all
```

Install specific skills by name:

Skill names match the live directories under `skills/`.
When adding or removing live skills, update these examples and the development list in the same change.

```sh
skills add connorch/skills --skill qa-ux-plan
skills add connorch/skills --skill qa-ux-fix-loop
skills add connorch/skills --skill qa-ux-verify
skills add connorch/skills --skill codex-review
skills add connorch/skills --skill codex-implementation
skills add connorch/skills --skill claude-code-subagent
skills add connorch/skills --skill step-back
skills add connorch/skills --skill pull-upstream
skills add connorch/skills --skill babysit-pr
skills add connorch/skills --skill file-pr
skills add connorch/skills --skill implement-and-review
skills add connorch/skills --skill handoff
skills add connorch/skills --skill html-communication
skills add connorch/skills --skill wovn-file-hosting
skills add connorch/skills --skill fleet-exec
skills add connorch/skills --skill jev
skills add connorch/skills --skill mac-vm
skills add connorch/skills --skill bambu-print
skills add connorch/skills --skill t3-browser
skills add connorch/skills --skill motion-explainer
```

You can also install multiple specific skills in one command:

```sh
skills add connorch/skills --skill qa-ux-plan qa-ux-verify qa-ux-fix-loop codex-review codex-implementation claude-code-subagent step-back pull-upstream babysit-pr file-pr implement-and-review handoff html-communication wovn-file-hosting fleet-exec jev mac-vm bambu-print t3-browser motion-explainer
```

## Shipping to your machines

`pnpm ship:fleet` installs this repo's skills, agent instructions, and CLIs on
every macOS and linux machine on your tailnet, in parallel. The machine you run
it from ships your working copy; every other machine resets a clone of this repo at
`~/.local/share/<owner>-<repo>` to `origin/main` over `tailscale ssh` and ships
that. Offline machines are skipped with a warning.

Output is one line per event, tagged `PLAN`, `RUN`, `SKIP`, `OK`, or `FAIL`, so
`grep FAIL` works on a saved log. Build output is hidden unless that machine
fails, in which case its full output prints under the `FAIL` line.

```
 0.2s  connors-macbook-pro  PLAN  working copy 41c471d · 15 skills · +15 new · wovn-cli
 0.5s  connors-macbook-pro  RUN   ship:machine wovn-cli
 0.9s  connors-macbook-pro  OK    15 skills (+15) · wovn-cli
 1.2s  bluefin              SKIP  offline
 1.2s  fleet                DONE  ok 1  skipped 1  failed 0
```

```sh
pnpm ship:fleet                         # every machine
pnpm ship:fleet --dry-run               # print each machine's plan, change nothing
pnpm ship:fleet --only connors-mac-studio
pnpm ship:machine                       # just this machine, from this checkout
```

Each machine needs `git`, `node` 24, and `pnpm`, and must accept Tailscale SSH:
on macOS that means the open-source `tailscaled` rather than Tailscale.app (see
[`docs/adr/0001-push-based-ship-over-tailscale-ssh.md`](docs/adr/0001-push-based-ship-over-tailscale-ssh.md)).

A skill chooses where it ships with optional `metadata` in its `SKILL.md`
frontmatter. The fields combine: a machine gets the skill only if it passes all
of them.

```yaml
metadata:
  agents: [claude-code] # skills CLI agent slugs. Default: [claude-code, codex]
  platforms: [darwin] # darwin and/or linux. Default: both
  machines: [connors-mac-studio] # tailnet names. Default: every machine
  fleet: false # only the machine running the ship. Default: true
```

A workspace package ships by defining a `ship:machine` script, which installs it
on the machine it runs on, and can restrict itself with the same fields (except
`agents`) under a `ship` key in its `package.json`.

Each machine records what ships have installed in
`~/.local/state/<owner>-<repo>/manifest.json`, so skills deleted, archived, or
retargeted in this repo are removed on the next ship. Skills installed from
anywhere else are never touched.

## Agent instructions

`instructions/` holds the global instructions every agent loads. `AGENTS.md` is
shared by every harness, and each harness gets it with its own `*_ONLY.md`
appended. A ship writes, overwriting what was there:

- `~/.agents/AGENTS.md` - `AGENTS.md`, for any other harness
- `~/.claude/CLAUDE.md` - `AGENTS.md` + `CLAUDE_ONLY.md`
- `~/.codex/AGENTS.md` - `AGENTS.md` + `CODEX_ONLY.md`

Edit them here, not on a machine. To review exactly what a ship would write,
a dry run writes the files under `instructions/dry-run/` (gitignored) instead,
and reports whether each is new, changed, or unchanged on this machine:

```sh
pnpm --dir instructions ship:machine --dry-run
```

## Development

These skills help you plan, verify, write, refactor, and fix code.

- **qa-ux-plan** — Generate end-to-end QA UX verification plans from the current branch's diff without executing tests.
- **qa-ux-verify** — Execute QA UX plans with browser automation and generate evidence-backed HTML reports without fixing issues.
- **qa-ux-fix-loop** — Execute QA UX plans, record issues, fix them serially, and require evaluator signoff.
- **codex-review** — Ask Codex CLI for an independent review of uncommitted changes, branch diffs, commits, or specific implementations.
- **codex-implementation** — Delegate bounded code changes to Codex CLI, then inspect the resulting diff and verification.
- **claude-code-subagent** — For non-Claude agents (Codex, Hermes, etc.): delegate bounded implementation, review, or investigation to Claude Code CLI (`claude -p`) on the user's Claude subscription, then inspect the result and diff.
- **step-back** — Step-back review of a branch after a batch of point fixes, finding and fixing the damage the iteration itself caused.
- **pull-upstream** - Sync a fork with its upstream: inventory the fork's features, merge upstream in with upstream taking priority, re-apply the fork's work on top, and verify every feature survived - clean merges included.
- **implement-and-review** - Take an approved plan through implementation, browser QA, PR filing, the review-bot loop with step-back every three Codex rounds, a final QA pass, and a handoff writeup of unplanned decisions and deferred findings.
- **handoff** - Compact the current conversation into a handoff document in the OS temp directory so a fresh agent can pick up the work. Invoked by the user only. Adapted from a skill by [Matt Pocock](https://github.com/mattpocock/skills).
- **babysit-pr** — Monitor a pull request through review and CI, verifying bot findings, fixing real failures, and dismissing false positives with reasons. Adapted from a skill by [Theo Browne](https://youtu.be/e1snsuY4lTI).
- **html-communication** — Create self-contained HTML writeups (plans, specs, findings, UI mocks) and publish them privately to files.wovn.org with the wovn CLI. Adapted from a skill by Theo Browne.
- **wovn-file-hosting** - Upload any local file to files.wovn.org and return a permanent URL (private by default, public on request), backed by the Cloudflare Worker in `apps/wovn-files/` and the `wovn` CLI in `apps/wovn-cli/`. Adapted from a skill by Theo Browne.
- **t3-browser** - Drive T3 Code's built-in Browser panel, which the user watches live, for browser QA and screenshots whenever its `preview_*` tools are available, reaching dev servers by environment port so they resolve to the machine running the code.
- **motion-explainer** - Turn a pull request, or a question about how something works, into a 1080p60 motion graphic explainer in the style of [Kit Langton's PR films](https://x.com/kitlangton/status/2106623769146233112), rendered with his [psychopomp](https://github.com/kitlangton/psychopomp) engine and published privately to files.wovn.org. Ships to macOS only.
- **jev** - Use TypeSafe's Jev decision model for bulk classification and fast Jev-driven browsing in the Agents Chrome, through the `jevx` CLI in `apps/jevx-cli/`. Ships only to connors-mac-studio.

## Fleet

- **fleet-exec** - Run commands on your other machines over Tailscale SSH ("make sure main is pulled on my MacBook Pro"), with the gotchas agents would otherwise hit: exit codes that always read 0, a locked keychain, and repo paths that differ per machine.
- **mac-vm** - Boot an on-demand macOS VM (Tart) whose desktop is always unlocked, so agents can drive GUI apps while the host Mac is locked, then shut it down. Backed by the `mac-vm` CLI in `apps/mac-vm/`. Ships only to connors-mac-studio.
- **bambu-print** - Design, slice, and start prints on the Bambu Lab P1S: status and camera over the LAN, models from code (parametric parts through the `cad` skill from [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad)), headless slicing that refuses bad profiles, a plate check before every print, printing through Bambu Connect in the mac-vm VM (works while the Mac is locked), and a check that filament actually loaded. Backed by the `bambu` CLI in `apps/bambu-cli/`. Ships only to connors-mac-studio.

## Workspace

The repo is a pnpm workspace with [vite-plus](https://viteplus.dev) at the
root. Skills live under `skills/` as plain directories; the code behind them
lives in `apps/` (see [`CONTEXT-MAP.md`](CONTEXT-MAP.md) for each app's
domain docs).

- `apps/wovn-files` - the files.wovn.org Worker (TanStack Start on
  Cloudflare).
- `apps/wovn-cli` - the `wovn` CLI the `wovn-file-hosting` and
  `html-communication` skills call.
- `apps/jevx-cli` - the `jevx` CLI the `jev` skill calls (Mac Studio only).
- `apps/mac-vm` - the `mac-vm` CLI the `mac-vm` skill calls (connors-mac-studio only).
- `apps/bambu-cli` - the `bambu` CLI for the P1S on the home LAN (connors-mac-studio only).
- `apps/claude-router` - the `claude-router` proxy and CLI the `claude-router` skill describes (both Macs).
- `apps/psychopomp` - clones Kit Langton's psychopomp engine to `~/.local/share/psychopomp` at a pinned commit and builds it, for the `motion-explainer` skill (macOS only).
- `apps/ship` - `pnpm ship:fleet` and `pnpm ship:machine`.
- `instructions` - the global agent instructions (see above).

```sh
pnpm install
pnpm ship:machine    # install skills, instructions, and CLIs here
pnpm dev:wovn-files  # the host with HMR
pnpm typecheck       # every workspace package
pnpm lint            # oxlint via vp
pnpm fmt             # oxfmt via vp (skills/ is left as written)
pnpm test            # every workspace package
```

## Archived Skills

Archived skills live under `archived/<skill-name>/` and do not use the live
`SKILL.md` filename. To restore one, move it back under `skills/<skill-name>/` and
rename `SKILL.archived.md` to `SKILL.md`.

- **code-trust-pragma** — Archived because it is no longer part of the live skill set.
- **codex-computer-use** — Archived because it is no longer part of the live skill set.
- **sb-ingest** - Archived because it is no longer part of the live skill set.
- **sb-ingest-superwhisper-meeting** - Archived because it is no longer part of the live skill set.
