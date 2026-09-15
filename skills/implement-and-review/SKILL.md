---
name: implement-and-review
description: >-
  Use when the user approves a plan and says to implement it. Takes the plan
  through implementation, browser QA, and the PR review loop to a PR that is
  ready to look at.
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
---

# Implement and Review

The plan is approved. Take it from here to a PR that has been implemented,
QA'd in a browser, reviewed by the bots, cleaned up after the review churn, and
QA'd again - ready for Connor to look at without further prompting.

This skill is the conductor. The heavy lifting lives in the skills it names;
read each one when you reach it instead of working from memory. Run the phases
in order and do not skip one because it seems unnecessary. If a phase genuinely
does not apply, say so in the final report.

## 1. Implement

Implement the approved plan as written. The plan is the scope: no extras, no
quiet narrowing. Run the repo's verification commands (typecheck, lint, format,
tests) before moving on.

## 2. QA

1. Run `qa-ux-plan` skill to build a QA plan from the branch diff.
2. Run `qa-ux-verify` skill to execute it with browser automation and produce the
   evidence report.
3. Apply a targeted fix for every real failure in the report, and retest each
   fix with browser automation as you go. A fix is not done until it has been
   re-verified. Fix the finding; do not redesign the feature because of it.

If the change has no user-facing surface, rely on the verification commands and
existing tests, and note in the final report that browser QA was not applicable.

## 3. File and babysit the PR

Run `file-pr`, then `babysit-pr` skills. Stay in the babysit loop until the review
bots and required checks are green on the latest commit.

### Codex review judgement

The Codex review bot (`chatgpt-codex-connector`) often overestimates severity.
A P1 may be a P3, or not an issue at all. Verify every finding against the
source and decide for yourself. You have full authority to decline a finding.
The PR's intended scope is yours to defend, and review feedback must not expand
it. Sort each finding into one bucket:

- **Fix now** - real, in scope, and worth the change.
- **Defer** - real or plausible, but out of scope for this PR or not worth the
  churn now. Record it for the handoff writeup in phase 5.
- **Dismiss** - not a real issue. Reply with the reason and resolve the thread,
  as `babysit-pr` describes.

### Step back every three rounds

A round is one review pass from the Codex bot on a pushed revision. After every
third round (3, 6, 9, ...), run `step-back` in fix mode before pushing further
fixes. Apply the residue cleanup and any in-scope changes it recommends;
architectural walk-backs that would widen the PR go in the handoff writeup
as deferred findings instead. If the loop ends with fix commits landed since the last step-back, run
it once more before the final QA pass.

## 4. Final QA

Code changed during the review loop. Rerun `qa-ux-verify` skill against the plan from
phase 2, updated if the review fixes changed any flow, and fix and retest
anything that regressed. Rerun the verification commands, push, and let
`babysit-pr` skill confirm the bots and checks are green on the final commit.

## 5. Handoff writeup

Use the `html-communication` skill to write one file with two sections:

- **Decisions not in the plan.** Every significant call made during
  implementation, QA fixes, review fixes, or step-back that the approved plan
  did not cover: what was decided, why, and what the alternative was. Connor
  reviews the PR against the plan, so anything that diverged from it belongs
  here. Track these as they happen; they are hard to reconstruct at the end.
- **Deferred findings.** The review findings worth a later PR: a link to each
  comment, what it flagged, why it was deferred, and the suggested follow-up
  scope. Leave out dismissed findings.

If both sections would be empty, skip the file and say so in the report.

## 6. Report

Report back with:

- The PR URL and a short summary of what shipped.
- QA outcome: the published report URL, what was fixed along the way, and
  anything not covered.
- Review outcome: how many Codex rounds ran, what was fixed, and when
  step-back ran.
- The handoff writeup URL, or a note that there were no unplanned decisions
  and nothing was deferred.
- Anything left open that needs Connor's decision.
