---
name: codex-review
description: Ask Codex CLI (gpt-5.5) for an independent code review of uncommitted changes, a branch diff, a commit, or a specific implementation. This is how gpt-5.5 is invoked for review work. Use when the user asks Claude to have Codex or gpt-5.5 review work, when the model-selection rubric calls for a gpt-5.5 review perspective, or when Codex should audit a diff, find bugs or regressions, or compare Claude's implementation against requirements. For a review by Claude itself, use the normal review process instead.
---

# Codex Review

Use Codex as an independent reviewer when the user wants a second pass or when a change is broad enough that another agent's perspective is useful.

Prefer Claude's normal review process for small local checks. Do not delegate review just to avoid reading the code yourself. Treat Codex's output as evidence, not authority.

## Two modes

### Full review (no custom prompt)

Use this when you want Codex's strongest built-in review pass. Codex runs its own correctness-focused pipeline with P0–P3 priority rankings, confidence scores, and structured file:line findings. You cannot append custom instructions — the targeting flags (`--uncommitted`, `--base`, `--commit`) conflict with any prompt argument by design.

```bash
ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-review.XXXXXX")"
REPORT="$ARTIFACT_DIR/report.md"

# Review staged, unstaged, and untracked changes.
codex -C "$PWD" review --uncommitted > "$REPORT"

# Review current branch against a base branch.
codex -C "$PWD" review --base main > "$REPORT"

# Review a single commit.
codex -C "$PWD" review --commit <sha> > "$REPORT"
```

Choose this when: the goal is comprehensive bug-finding with no specific angle, the diff is large, or you want Codex's independent judgment without steering it.

### Focused review (custom prompt)

Use this when you have a specific question, a risky area to probe, or context Codex wouldn't discover on its own. You collect the diff and combine it with your instructions into a single prompt using the `Custom` target mode (no targeting flag). Codex still applies its review rubric as the system prompt, but the user-turn is entirely yours.

```bash
ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-review.XXXXXX")"
REPORT="$ARTIFACT_DIR/report.md"

# Collect the diff first — scope it to avoid blowing up the prompt on large commits.
# Examples: git show HEAD, git diff main...HEAD, git diff --cached, git diff HEAD
DIFF="$(git show HEAD)"

codex -C "$PWD" review - > "$REPORT" << EOF
Review the changes introduced by commit $(git rev-parse --short HEAD).

$DIFF

Focus on: <your specific concern here — auth boundaries, error handling, migration safety, etc.>

For each finding include severity, file:line, the concrete failure mode, and a fix direction.
If there are no substantive findings, say so.
EOF
```

Scope the diff to keep the prompt manageable. For large commits, use `git show HEAD --stat` to orient first, then scope to specific files with `git show HEAD -- path/to/file`. For uncommitted changes use `git diff HEAD`.

Choose this when: you have a specific concern (e.g. "is the auth check missing on this new endpoint?"), you're providing extra context Codex can't see (requirements, prior bugs, risk areas), or you want to scope the review to a subset of the changes.

**Limitation:** Custom mode requires you to supply the diff. Codex will not auto-discover untracked files or staged-only hunks the way the native targeting flags do. For full working-tree coverage, prefer `--uncommitted`.

## Reporting Back

Before relaying a Codex finding, inspect the cited code or diff enough to decide whether the finding is real. In the user-facing response, separate confirmed issues from Codex suggestions you did not verify.

If Codex finds nothing, say that clearly and mention what review target it inspected.

If `codex` is not installed or the command fails, report the error and offer to review the changes directly instead.
