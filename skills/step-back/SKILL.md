---
name: step-back
description: >-
  Step-back review of a branch that absorbed a series of individually applied
  point fixes (review findings, bug reports, PR feedback), looking for damage
  caused by the iteration itself - dead code, misplaced abstractions, redundant
  guards, stale docs, unhardened new mechanisms - then fixing it. Use when asked
  to "take a step back", run a "step-back review", do a "post-churn cleanup", or
  check whether "the fixes left any weirdness", and after finishing a batch of
  sequential review fixes on one branch. Not a bug hunt and not a style pass.
---

# Step Back

A branch has absorbed a series of point fixes, each applied and committed on its
own. Every fix was locally correct, but nobody has read the result as a whole.
Stepping back means viewing the full branch diff at a higher level, confirming
the final state has the right overall shape, and fixing what does not.

The unit under review is the **end state**, not the sequence of fixes that
produced it.

This skill looks only for damage caused by iteration. It is **not a bug hunt** -
pre-existing bugs unrelated to the churn belong in a code review - and **not a
style pass** - naming and formatting preferences are out of scope unless a fix
left the code actively misleading. Note anything serious but out of scope in the
report instead of fixing it.

## Method requirements

Non-negotiable, and they shape every step:

- **Re-read the final state of every changed file fresh.** Do not reason from
  memory of individual fixes, and do not review per-commit diffs - that view is
  exactly what hides this class of problem.
- **Verify empirically where it is cheap.** Grep for consumers instead of
  recalling them, run the script, exercise the fast path. Inspection alone is
  the weakest evidence available.
- **Classify every finding** as fixed or explicitly kept. "Considered and
  deliberately kept" is a valid outcome and must be reported, never silently
  skipped.

## Workflow

**1. Establish the end state.** Confirm branch and base (default `main`). Run
`git diff --stat <base>...HEAD` for the touched surface and
`git log --oneline <base>..HEAD` for context on what the fixes claimed to do -
context only, do not review those diffs. Then read the *current contents* of
every changed file, plus enough surrounding module context to know which
directory owns core logic, which owns app or CLI concerns, and which owns shared
utilities. Step 2 judges placement against those existing boundaries, not taste.

**2. Run all five lenses.** Each has a required verification step; do not
substitute an opinion for the check. Full checklists and the failure modes to
watch for: [references/lenses.md](references/lenses.md).

1. **Dead and orphaned code** - for every helper, export, and fixture the branch
   touched, map consumers in the final state by grep and confirm live callers
   outside its own tests.
2. **Abstractions in the wrong place** - fixes land where the bug was reported,
   not where the logic belongs. Also check the opposite failure: distinct
   concerns that merely look like duplication, which must not be merged.
3. **Redundant logic from layered fixes** - trace the final control flow for
   branches that can no longer be taken and guards a later fix subsumed.
4. **Documentation and comment drift** - verify every checkable claim (counts,
   file lists, described behaviors, "X is the only place that...") against the
   final code.
5. **Hardening the fixes forgot** - for each mechanism a fix *added*, ask what
   happens when it hangs, fails, or lies.

**3. Classify.** For each finding record `file:line`, the lens, the churn that
produced it, the verdict (fix or keep), and for keeps the one-line reason it is
correct as-is.

**4. Fix and verify.** Apply the fixes, run the repo's own verification commands
(lint, typecheck, tests, format), and re-run any empirical check whose subject
you changed. Then commit - small related cleanups may share one commit, and the
message must explain *what churn produced each artifact*:

```
Settle post-review churn on the launcher path

- Drop resolveLegacyRoot; the retry fix in 3f2a1c9 rerouted its only caller
- Move formatProbeArgs into probe/, which already owns arg construction
- Add a 5s timeout to the startup health probe added by the hang fix
- Correct "three guarded spots" in docs/probes.md; there are now two
```

If verification fails because of a step-back fix, fix it before reporting.
If the failure predates the branch, report it and leave it.

**5. Report** in exactly two sections:

```md
## What the churn broke (fixed)

- **<file:line>** - <what was wrong>. Left behind by <which fix>. <What changed.>

## Examined and deliberately kept

- **<file:line>** - <what it looks like> is correct as-is: <one-line reason>.
```

Every finding appears in exactly one section. The kept section is not optional;
if it is empty, say so explicitly, since that usually means the sweep was not
skeptical enough. One line per item, no re-explaining the original fixes. Add a
third section, "Out of scope, noted", only for pre-existing failures or serious
issues outside this skill's scope.
