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
skills add connorch/skills --skill step-back
skills add connorch/skills --skill pull-upstream
skills add connorch/skills --skill babysit-pr
skills add connorch/skills --skill file-pr
skills add connorch/skills --skill implement-and-review
skills add connorch/skills --skill html-communication
skills add connorch/skills --skill wovn-file-hosting
skills add connorch/skills --skill sb-ingest
skills add connorch/skills --skill sb-ingest-superwhisper-meeting
```

You can also install multiple specific skills in one command:

```sh
skills add connorch/skills --skill qa-ux-plan qa-ux-verify qa-ux-fix-loop codex-review codex-implementation step-back pull-upstream babysit-pr file-pr implement-and-review html-communication wovn-file-hosting sb-ingest sb-ingest-superwhisper-meeting
```

## Fleet sync (macOS)

Fleet sync keeps this repo's skills on each Mac aligned with GitHub's `main`.
It uses a pinned Skills CLI, checks every five minutes after desktop login,
and works while the screen is locked and the Mac is awake. Merge or push to
remote `main` to publish an update. Local worktree edits are not installed.

### Set up each Mac

After the fleet implementation has merged into `main`, clone this repository
and install its dependencies. Use Node **22.18 or later** and pnpm **10.34.3**.
Git must also be available through the macOS command-line developer tools.

```sh
pnpm install --frozen-lockfile
pnpm fleet setup --machine laptop
# On the Studio, use a distinct name:
pnpm fleet setup --machine studio
```

Run setup only on the machine named by the command. Each name must be unique
across your fleet; it becomes the machine's private Wovn report prefix.
Setup requires an existing Wovn token in
`~/.config/wovn-files/token.txt`. Provision that credential securely on each
Mac; do not put it in this repo or in the LaunchAgent plist.

Setup registers `org.wovn.skills-fleet` in your user LaunchAgents and starts
sync immediately. It needs a desktop login session, but no administrator
permission. After a restart, log into the desktop once. SSH alone does not
replace that login requirement. No app or terminal needs to stay open.

The service stores its own checkout and state under
`~/.local/state/skills-fleet`. It never checks out or resets your development
worktree. It records absolute Node and pnpm executable paths. If a runtime
manager removes those executables, rerun setup. Use `--pnpm /absolute/path`
to choose a persistent pnpm executable explicitly.

### Commands

```sh
pnpm fleet sync           # Fetch and reconcile remote main now
pnpm fleet status         # Installed commit, last attempt, and reporting errors
pnpm fleet status --json  # Full local state for tools and agents
pnpm fleet uninstall      # Remove the scheduled job; retain skills and records
```

`pnpm conductor:run` and the existing Conductor/T3 install action now invoke
fleet sync against remote `main`. They no longer install a local branch.
Setup must be completed first. A manual sync and a scheduled sync cannot
reconcile at the same time.

### Agent targeting

Ordinary skills target `claude-code` and `codex`. To select other targets,
add a comma-separated string under the skill's frontmatter metadata:

```yaml
metadata:
  install-agents: "claude-code"
```

```yaml
metadata:
  install-agents: "codex,cursor,opencode"
```

The supported slugs come from the pinned Skills CLI. Whitespace is trimmed;
empty values, unknown slugs, and targets without global installation support
fail preflight before installed skills change. These are installation targets,
not exclusive visibility rules: multiple harnesses read shared directories.

The CLI decides placement. Version 1.5.7 automatically copies a Claude-only
skill to Claude's directory without a shared copy. Shared targeting uses the
CLI's normal shared-directory and symlink behavior. `codex-review` and
`codex-implementation` explicitly target Claude Code. Names do not control
agent targeting.

Fleet uses standard user directories. It does not inherit `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, or other harness-directory overrides from an interactive
shell. Configure custom-directory installations separately; do not assume
fleet will manage them.

### Ownership and failures

Preflight installs the desired skills into temporary homes with the real CLI.
This validates the full collection and records the paths and contents that
will be installed, without a duplicate agent registry.

On first sync, existing copies are adopted if their contents match the desired
skill (ignoring only the new targeting metadata), or if the CLI's global lock
records `connorch/skills` as their GitHub source. A matching name alone is not
enough. Unproven collisions stop the entire update before installed skills
change. Back up and move the reported conflicting skill directory out of the
agent's skills directory, then retry. Unrelated skills are left alone.

After adoption, fleet records its placements. It removes obsolete owned paths
when skills are deleted, archived, renamed, or retargeted. Cleanup uses that
inventory, not the CLI's agent-detection-based removal heuristic. If an owned
installation was edited outside fleet, it stops rather than deleting the edit;
move the changed copy aside and retry. Fleet does not provide local overrides.

A failure before installation leaves installed skills intact. An interrupted
installation can leave a partial update: status retains the last fully
installed commit, records the failed attempt, and retries on the next check.
There is no atomic rollback across agent directories. Pending destinations
are journaled before changes so retries can recover partial CLI output.

Logs and state are local to the machine. `status` also shows fetch/bootstrap
and reporting errors. If the Mac is offline it retains its installed skills
and retries later. A stale process lock is reclaimed after both the launcher
and installation process have exited. If lock recovery itself was interrupted,
remove `sync.reclaim` from the state directory only after confirming no fleet
process is running, then retry.

### Private Wovn reports

Each completed installation attempt writes:

```text
skills-fleet/<machine>/status.json
skills-fleet/<machine>/logs/<run-id>.log
```

Status includes the installed commit and time, attempted commit and outcome,
CLI version, changes, error, and log Key. Reports use explicit private
visibility. The existing Wovn HTTP upload API is used directly; no globally
installed Wovn CLI or hosting changes are required at runtime.

There is no heartbeat and no upload for an unchanged check. Fetch failures
before an installation attempt stay in local status. A missing report cannot
distinguish a sleeping machine from a broken scheduler. Compare the installed
commit with GitHub `main` to detect lag.

A Wovn outage never blocks installation. Local reports remain queued, and later
checks retry them. Logs have unique stable keys; retries do not create duplicate
log versions. The latest status is published after the backlog's logs, so an
older attempt cannot replace a newer report. Local and remote attempt logs are
retained; no automatic retention policy is applied.

### Development checks

```sh
pnpm typecheck
pnpm test
pnpm format:check
```

Tests run real CLI installations in temporary homes. They do not change your
installed skills, register a LaunchAgent, or upload to Wovn. Update the pinned
`skills` dependency and lockfile together, then run these checks before merging.
The fleet refreshes its dependencies and sync implementation from remote main.

## Development

These skills help you plan, verify, write, refactor, and fix code.

- **qa-ux-plan** — Generate end-to-end QA UX verification plans from the current branch's diff without executing tests.
- **qa-ux-verify** — Execute QA UX plans with browser automation and generate evidence-backed HTML reports without fixing issues.
- **qa-ux-fix-loop** — Execute QA UX plans, record issues, fix them serially, and require evaluator signoff.
- **codex-review** — Ask Codex CLI for an independent review of uncommitted changes, branch diffs, commits, or specific implementations.
- **codex-implementation** — Delegate bounded code changes to Codex CLI, then inspect the resulting diff and verification.
- **step-back** — Step-back review of a branch after a batch of point fixes, finding and fixing the damage the iteration itself caused.
- **pull-upstream** - Sync a fork with its upstream: inventory the fork's features, merge upstream in with upstream taking priority, re-apply the fork's work on top, and verify every feature survived - clean merges included.
- **implement-and-review** - Take an approved plan through implementation, browser QA, PR filing, the review-bot loop with step-back every three Codex rounds, a final QA pass, and a handoff writeup of unplanned decisions and deferred findings.
- **babysit-pr** — Monitor a pull request through review and CI, verifying bot findings, fixing real failures, and dismissing false positives with reasons. Adapted from a skill by [Theo Browne](https://youtu.be/e1snsuY4lTI).
- **html-communication** — Create self-contained HTML writeups (plans, specs, findings, UI mocks) and publish them privately to files.wovn.org with the wovn CLI. Adapted from a skill by Theo Browne.
- **wovn-file-hosting** - Upload any local file to files.wovn.org and return a permanent URL (private by default, public on request), backed by the Cloudflare Worker in `skills/wovn-file-hosting/worker/`. Adapted from a skill by Theo Browne.

## Second Brain

These skills feed Connor's second-brain Obsidian vault.

- **sb-ingest** — File any pasted content (conversation, email, notes, transcript, or a file path) verbatim into the vault's `Sources/` directory so the vault automation ingests it.
- **sb-ingest-superwhisper-meeting** — Find unprocessed superwhisper meeting recordings, build speaker-separated transcripts, identify speakers via calendar and transcript evidence, and file them into `Sources/`.

## Archived Skills

Archived skills live under `archived/<skill-name>/` and do not use the live
`SKILL.md` filename. To restore one, move it back under `skills/<skill-name>/` and
rename `SKILL.archived.md` to `SKILL.md`.

- **code-trust-pragma** — Archived because it is no longer part of the live skill set.
- **codex-computer-use** — Archived because it is no longer part of the live skill set.
