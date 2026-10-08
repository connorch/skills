---
name: implement-and-review
description: >-
  Use when the user approves a plan and says to implement it. Takes the plan
  through implementation, browser QA, and the PR review loop to a PR that is
  ready to look at.
---

# Implement and Review

The plan is approved. Take it from here to a PR that has been implemented,
QA'd in a browser, reviewed by the bots, cleaned up after the review churn, and
QA'd again - ready for Connor to look at without further prompting.

This skill is the conductor. The heavy lifting lives in the skills it names;
read each one when you reach it instead of working from memory. Run the phases
in order and do not skip one because it seems unnecessary. If a phase genuinely
does not apply, say so in the final report.

Copy this checklist and track your progress:

```
- [ ] 1. Implement, and pass the verification commands
- [ ] 2. QA: plan, verify, fix and retest failures
- [ ] 3. File and babysit the PR, stepping back every third Codex round
- [ ] 4. Final QA, with bots and checks green on the final commit
- [ ] 5. Handoff writeup
- [ ] 6. Explainer video, if merge risk is Moderate or higher
- [ ] 7. Report
```

## 1. Implement

Implement the approved plan as written. The plan is the scope: no extras, no
quiet narrowing. Run the repo's verification commands (typecheck, lint, format,
tests) before moving on.

## 2. QA

1. Run the $qa-ux-plan skill to build a QA plan from the branch diff.
2. Run the $qa-ux-verify skill to execute it with browser automation and produce the
   evidence report.
3. Apply a targeted fix for every real failure in the report, and retest each
   fix with browser automation as you go. A fix is not done until it has been
   re-verified. Fix the finding; do not redesign the feature because of it.

If the change has no user-facing surface, rely on the verification commands and
existing tests, and note in the final report that browser QA was not applicable.

## 3. File and babysit the PR

Run the $file-pr skill, then the $babysit-pr skill. Stay in the babysit loop
until the review bots and required checks are green on the latest commit.

### Triage review findings

Triage every review finding with the rubric in the $babysit-pr skill. Follow it
exactly as that skill states it, and re-read it there rather than working from
memory or substituting your own criteria. One addition: when a finding is real
but fails the rubric because it is out of scope or not worth the change, also
record it for the deferred findings in phase 5.

### Step back every three rounds

A round is one review pass from the Codex bot on a pushed revision. After every
third round (3, 6, 9, ...), run the $step-back skill in fix mode before pushing further
fixes. Apply the residue cleanup and any in-scope changes it recommends;
architectural walk-backs that would widen the PR go in the handoff writeup
as deferred findings instead. If the loop ends with fix commits landed since the last step-back, run
it once more before the final QA pass.

## 4. Final QA

Code changed during the review loop. Rerun the $qa-ux-verify skill against the plan from
phase 2, updated if the review fixes changed any flow, and fix and retest
anything that regressed. Rerun the verification commands, push, and let
the $babysit-pr skill confirm the bots and checks are green on the final commit.

## 5. Handoff writeup

Use the $html-communication skill to write one file with two sections:

- **Decisions not in the plan.** Every significant call made during
  implementation, QA fixes, review fixes, or step-back that the approved plan
  did not cover: what was decided, why, and what the alternative was. Connor
  reviews the PR against the plan, so anything that diverged from it belongs
  here. Track these as they happen; they are hard to reconstruct at the end.
- **Deferred findings.** The review findings worth a later PR: a link to each
  comment, what it flagged, why it was deferred, and the suggested follow-up
  scope. Leave out dismissed findings.

If both sections would be empty, skip the file and say so in the report.

## 6. Explainer video

Only once everything above is done: the PR is reviewed, QA'd, and green on its
final commit.

1. Run the $merge-risk skill on the PR's final commit. It rates the PR in a
   subagent. If the rating is Minimal or Low, skip the rest of this phase and
   give the rating in the report.
2. Run the $motion-explainer skill on the PR.
3. Upload the local MP4 to GitHub itself and embed it in the PR description.
   GitHub plays only videos on its own CDN, so do not use the Wovn link. GitHub
   has no API for attachments: edit the PR description in a browser signed in
   to GitHub, attach the file through the editor, and wait for the upload to
   finish. It inserts a `https://github.com/user-attachments/assets/...` URL on
   its own line, which GitHub renders as a player. Keep it at the end of the
   description, above the model and harness blurb, and save.
4. If GitHub rejects the file as too large, re-encode it smaller with ffmpeg
   (lower the bitrate, keep 1080p) and upload again.
5. Reload the PR and confirm the video plays.

## 7. Report

Report back with:

- The PR URL and a short summary of what shipped.
- QA outcome: the published report URL, what was fixed along the way, and
  anything not covered.
- Review outcome: how many Codex rounds ran, what was fixed, and when
  step-back ran.
- The handoff writeup URL, or a note that there were no unplanned decisions
  and nothing was deferred.
- The merge risk rating, and whether the explainer video is in the PR
  description.
- Anything left open that needs Connor's decision.
