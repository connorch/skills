---
name: step-back
description: >-
  Step back from a branch that grew through iteration - review rounds, point
  fixes, PR feedback - and judge the end state as a whole: are the big
  architecture calls right, are abstractions drawn in the right places, is
  logic shared when appropriate, and did the churn leave residue (dead code,
  redundant guards, stale docs, duplicated machinery, untested hot paths)?
  Produces a verdict-first assessment; fixes only when asked. Use when asked to
  "take a step back", run a "step-back review", assess "the shape of the
  changes", judge "optimal end state vs tech debt", do a "post-churn cleanup",
  or after finishing a batch of sequential review fixes on one branch. Not a
  bug hunt and not a style pass.
---

# Step Back

A branch has grown through iteration: an initial design plus rounds of review
findings, bug reports, and point fixes, each applied and committed on its own.
Every change was locally justified, but nobody has judged the result as a
whole. Stepping back means reading the final state at full altitude and
answering one question: **is this the end state a good engineer would have
designed outright, or does it encode the path that produced it?**

The unit under review is the **end state**, not the sequence of fixes. Two
scope limits: this is **not a bug hunt** - pre-existing bugs unrelated to the
branch belong in a code review - and **not a style pass** - naming and
formatting preferences are out of scope unless something is actively
misleading. Note anything serious but out of scope in the report.

**Order matters: form the architectural verdict first, sweep for mechanical
residue second.** Checklist-first reviews sink into grep sweeps and produce a
flat list of trivia while missing the shape. The highest-value findings are
architectural; the sweeps exist to serve and then supplement that verdict.

## Mode

- **Assess** - the default, and always when the invocation is a question ("how
  is the shape", "give me your assessment"). Deliver the report, change
  nothing, offer the cleanup.
- **Fix** - only when explicitly instructed to clean up. Produce the same
  assessment first, then apply step 5.

## Workflow

**1. Establish the end state.**

- `git fetch` before diffing; the base is `origin/<main>` (or the stated
  base), not local `main` - a stale local base contaminates the diff with
  already-merged work. Use `git diff <base>...HEAD` (three-dot) or the
  merge-base explicitly.
- Build a churn map from `git log --oneline --stat <base>..HEAD`: how many
  rounds of fixes, and which files they piled up on. Churn concentration is
  targeting evidence - it predicts where debt and missing tests sit. Use it
  only to aim; never review per-commit diffs, since that view is exactly what
  hides this class of problem.
- Read the branch's design doc or ADR if one exists, plus governing docs the
  branch touches (CONTEXT.md, module READMEs). These are the judging frame:
  the branch is held to its own stated invariants and goals, not to taste.
- Read the *current contents* of every changed file fresh - whole files, not
  diff hunks - plus enough surrounding module context to know the existing
  boundaries: which directory owns core logic, which owns app or CLI concerns,
  which owns shared utilities.

**2. Shape pass.** Form the architectural verdict. The six questions, each
with its method, are in [references/shape.md](references/shape.md):

1. Judge the big calls on their merits
2. Invariant erosion - stated invariants vs the exceptions fixes threaded in
3. Placement and sharing - boundaries, duplication, distinct concerns
4. Live duplication from hardening rounds
5. Rigor consistency - effort vs the branch's own declared stakes, tests vs
   churn concentration
6. Forward fit - do the next phases consume this unchanged?

**3. Residue sweep.** Mechanical churn artifacts: dead and orphaned code,
redundant guards, doc and comment drift, hardening the fixes forgot.
Checklists in [references/residue.md](references/residue.md). Every check is
empirical - grep for consumers, trace the control flow, count the claim -
never substitute an opinion for the check. Aim the sweep with the churn map
and the shape findings.

**4. Report.** Verdict first, in this structure:

```md
**Verdict:** <one paragraph: are the foundations right, where the debt
concentrates, and whether it is the fingerprint of the iteration or of the
initial design>

## What's shaped well

- **<decision>** - <why it is right: the property it buys, the class of bug it
  makes unrepresentable, the existing pattern it matches>.

## What I'd change

<Ranked prose, heaviest first. Name the single thing to actively walk back and
the gap to close first; mark minor notes as minor. For each: what is wrong,
what churn produced it, the concrete alternative anchored to a pattern the
codebase already has, and the cost of leaving it.>

## Residue

- **<file:line>** - <artifact>. Left behind by <which fix>. <What changed, or
  the proposed fix in assess mode.>
- Examined and kept: **<file:line>** - <what it looks like> but correct as-is:
  <one-line reason>.

## Out of scope, noted

<pre-existing or unrelated issues found along the way; omit if empty>
```

Writing rules: complete sentences, not fragment bullets. "What's shaped well"
is mandatory and must carry the *why* - affirmation with reasons is what makes
the criticism credible; without it the report reads as a lint dump. Every
proposed change names a concrete alternative, ideally one the codebase already
uses elsewhere. Attribute debt honestly: "review-round accretion" and "wrong
initial call" have different fixes, so say which one produced each finding.
"Examined and kept" is not optional; if it is empty, say so - that usually
means the sweep was not skeptical enough.

**5. Fix (fix mode only).** Apply the changes, run the repo's own verification
commands (lint, typecheck, tests, format), and re-run any empirical check
whose subject changed. Small related cleanups may share one commit, and the
message must explain what churn produced each artifact:

```
Settle post-review churn on the launcher path

- Drop resolveLegacyRoot; the retry fix in 3f2a1c9 rerouted its only caller
- Move formatProbeArgs into probe/, which already owns arg construction
- Add a 5s timeout to the startup health probe added by the hang fix
- Correct "three guarded spots" in docs/probes.md; there are now two
```

If verification fails because of a step-back fix, fix it before reporting. If
the failure predates the branch, report it and leave it. Architectural
walk-backs from "What I'd change" are their own decision: propose them in the
report and apply only the ones the user approved or the invocation clearly
covered.
