# Agent Skills

A collection of agent skills that extend capabilities across planning, development, and tooling.

## Installation

Install all skills from the repository's `main` branch:

```sh
skills add connorch/skills --all
```

Install specific skills by name:

```sh
skills add connorch/skills --skill qa-ux-plan
skills add connorch/skills --skill qa-ux-fix-loop
skills add connorch/skills --skill qa-ux-verify
skills add connorch/skills --skill codex-review
skills add connorch/skills --skill codex-implementation
skills add connorch/skills --skill codex-computer-use
```

You can also install multiple specific skills in one command:

```sh
skills add connorch/skills --skill qa-ux-plan qa-ux-verify qa-ux-fix-loop codex-review codex-implementation codex-computer-use
```

Install the current local checkout with Conductor's agent targeting:

```sh
pnpm conductor:run
```

This installs `codex-*` skills for Claude Code only, installs the remaining live
skills for both Claude Code and Codex, and uses the local `skills/` directory
rather than the repository's remote branch.

## Development

These skills help you plan, verify, write, refactor, and fix code.

- **qa-ux-plan** — Generate end-to-end QA UX verification plans from the current branch's diff without executing tests.
- **qa-ux-verify** — Execute QA UX plans with browser automation and generate evidence-backed HTML reports without fixing issues.
- **qa-ux-fix-loop** — Execute QA UX plans, record issues, fix them serially, and require evaluator signoff.
- **codex-review** — Ask Codex CLI for an independent review of uncommitted changes, branch diffs, commits, or specific implementations.
- **codex-implementation** — Delegate bounded code changes to Codex CLI, then inspect the resulting diff and verification.
- **codex-computer-use** — Ask Codex CLI to verify local app and UI flows with browser automation, screenshots, simulators, or app launching.

## Archived Skills

Archived skills live under `archived/<skill-name>/` and do not use the live
`SKILL.md` filename. To restore one, move it back to the repository root and
rename `SKILL.archived.md` to `SKILL.md`.

- **code-trust-pragma** — Archived because it is no longer part of the live skill set.
