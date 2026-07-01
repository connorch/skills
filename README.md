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
```

You can also install multiple specific skills in one command:

```sh
skills add connorch/skills --skill qa-ux-plan qa-ux-verify qa-ux-fix-loop
```

## Development

These skills help you plan, verify, write, refactor, and fix code.

- **qa-ux-plan** — Generate end-to-end QA UX verification plans from the current branch's diff without executing tests.
- **qa-ux-verify** — Execute QA UX plans with browser automation and generate evidence-backed HTML reports without fixing issues.
- **qa-ux-fix-loop** — Execute QA UX plans, record issues, fix them serially, and require evaluator signoff.

## Archived Skills

Archived skills live under `archived/<skill-name>/` and do not use the live
`SKILL.md` filename. To restore one, move it back to the repository root and
rename `SKILL.archived.md` to `SKILL.md`.

- **code-trust-pragma** — Archived because it is no longer part of the live skill set.
