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
```

You can also install multiple specific skills in one command:

```sh
skills add connorch/skills --skill qa-ux-plan qa-ux-verify qa-ux-fix-loop codex-review codex-implementation step-back
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
- **step-back** — Step-back review of a branch after a batch of point fixes, finding and fixing the damage the iteration itself caused.

## Archived Skills

Archived skills live under `archived/<skill-name>/` and do not use the live
`SKILL.md` filename. To restore one, move it back under `skills/<skill-name>/` and
rename `SKILL.archived.md` to `SKILL.md`.

- **code-trust-pragma** — Archived because it is no longer part of the live skill set.
- **codex-computer-use** — Archived because it is no longer part of the live skill set.
