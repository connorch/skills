# Agent Skills

A collection of agent skills that extend capabilities across planning, development, and tooling.

## Installation

Install all skills from the repository's `main` branch:

```sh
skills add connorch/skills --all
```

Install specific skills by name:

```sh
skills add connorch/skills --skill code-trust-pragma
skills add connorch/skills --skill qa-ux-plan
skills add connorch/skills --skill qa-ux-fix-loop
skills add connorch/skills --skill qa-ux-verify
```

You can also install multiple specific skills in one command:

```sh
skills add connorch/skills --skill code-trust-pragma qa-ux-plan qa-ux-verify qa-ux-fix-loop
```

## Development

These skills help you plan, verify, write, refactor, and fix code.

- **code-trust-pragma** — Use top-line `@airef` pragmas to control how AI models reference files when selecting implementation examples.
- **qa-ux-plan** — Generate end-to-end QA UX verification plans from the current branch's diff without executing tests.
- **qa-ux-verify** — Execute QA UX plans with browser automation and generate evidence-backed HTML reports without fixing issues.
- **qa-ux-fix-loop** — Execute QA UX plans, record issues, fix them serially, and require evaluator signoff.
