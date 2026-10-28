---
name: shape-fix
description: >-
  Trigger this if the user says 'shape fix', or when another skill calls for
  it.
---

# Shape Fix

Run a shape check on the branch, then fix what it found. The assessment is the
$shape-check skill's; this skill adds the fixing.

## 1. Get the report

If this conversation already has a $shape-check report and HEAD has not moved
since it was written, fix from that report, keeping its IDs. Otherwise run
steps 1-4 of the $shape-check skill now and deliver the report before changing
anything.

If the user named IDs ("do B2, skip C4"), fix only those.

## 2. Decide what to apply

- **Residue** and **in-scope changes** from "What I'd change": apply.
- **Architectural walk-backs** - changes that would widen the PR past its
  intent: apply only the ones the user approved. List the rest in the final
  report as follow-ups, with the finding ID, what it flagged, and the suggested
  follow-up scope.

## 3. Fix and verify

Apply the changes, run the repo's own verification commands (lint, typecheck,
tests, format), and re-run any empirical check whose subject changed. Small
related cleanups may share one commit, and the message must explain what churn
produced each artifact:

```
Settle post-review churn on the launcher path

- Drop resolveLegacyRoot; the retry fix in 3f2a1c9 rerouted its only caller
- Move formatProbeArgs into probe/, which already owns arg construction
- Add a 5s timeout to the startup health probe added by the hang fix
- Correct "three guarded spots" in docs/probes.md; there are now two
```

If verification fails because of a shape fix, fix it before reporting. If the
failure predates the branch, report it and leave it.

## 4. Report

For each finding ID: what changed and the commit it landed in, or why it was
left. Then the follow-ups from step 2, and any verification failure that
predates the branch.
