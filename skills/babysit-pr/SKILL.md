---
name: babysit-pr
description: Use when the user asks to monitor, watch, or babysit a PR
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
---

# Babysit PR

All the repos we work in have various AI review bots. They're helpful, even if
they are not always right.

If your harness offers tools to monitor a PR, use them so you can respond when
comments arrive. Otherwise, poll the PR for new comments and checks.

Only act on checks and comments newer than the latest push. Verify every bot
finding against the source before changing code. Fix real findings and CI
failures, distinguish repository failures from infrastructure flakes, and reply
with a written reason when dismissing false positives.

Keep an eye on changes to `main` and rebase when needed. If an overlapping PR
makes this one obsolete, stop monitoring, report it to the user, and ask before
closing the PR unless closure was explicitly authorized.

If a review bot leaves feedback you believe is not worth addressing, reply and
resolve the comment. Resolving or dismissing a comment means marking its thread
as resolved in GitHub (e.g. via the `resolveReviewThread` GraphQL mutation with
`gh api graphql`), not just replying. Format comments left on Connor's behalf
as:

```md
[MODEL-SLUG] RESPONDING ON BEHALF OF CONNOR
-----

[actual reply]
```

Screenshots and videos help as well. Use the `file-upload` skill when needed.

Do not let review feedback expand the PR beyond the user's original goal.
Address real shortcomings, but avoid scope creep.

If nothing has changed, stay quiet rather than posting filler comments. Stop
when the review bots and required checks are green on the latest commit. Merge
only when the user explicitly requested it; otherwise report that the PR is
ready.
