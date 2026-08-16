---
name: pull-upstream
description: Sync a forked repository with its upstream - inventory the fork's own features, inventory what upstream has added, merge upstream in with upstream taking priority, re-establish the fork's features on top, and verify nothing broke, clean merges included. Use when asked to "pull upstream", "sync the fork", "merge upstream", "update the fork", or "catch up with upstream".
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
---

# Pull Upstream

Bring upstream into the fork as cleanly as possible. Upstream is the source of truth for shared code; the fork's own features are the payload to protect. When the two collide, take upstream's version of the mechanics and re-apply the fork's intent on top. When upstream has built its own version of something the fork built, or something that clearly collides with the intent of Connor's work, stop and ask Connor rather than picking a winner.

## 1. Locate upstream

Use the `upstream` remote if it exists. Otherwise derive it from `gh repo view --json parent` and add it; if there is no parent and no obvious upstream, ask. `git fetch upstream` and identify upstream's default branch.

## 2. Inventory the fork's features

The fork's work is the commits reachable from the fork branch but not from upstream: `git log --oneline upstream/<default>..HEAD`. Drop patches that already landed upstream under different SHAs using `git cherry upstream/<default>`. Authorship (`git log --author`) is a cross-check only - it misses squash-merged PRs and includes work that was already upstreamed.

Group the remaining commits into a feature inventory: each feature's purpose, the files it owns, and a concrete way to verify it still works. This inventory drives conflict resolution in step 4 and is the checklist for step 5, so vague entries are not acceptable.

## 3. Inventory upstream's new work

List what the merge will bring in: `git log --oneline HEAD..upstream/<default>` plus `git diff --stat HEAD...upstream/<default>` for shape. Compare it against the feature inventory before merging:

- Upstream touched files a fork feature owns: expect conflicts and plan how to re-apply the feature on top.
- Upstream built its own version of a fork feature on something that contradicts the intent of a fork feature: stop and ask Connor which to keep - upstream's version, the fork's, or a blend. Never decide this unilaterally.

## 4. Merge

Work on a dedicated branch (e.g. `merge/upstream-<date>`); never merge directly on the fork's main branch, and never force-push. Run `git merge upstream/<default>`.

Resolve each conflict with a fixed priority: upstream's change is the base, then re-apply what the fork's feature needs on top, keeping both sides feature-complete. If a resolution would have to sacrifice upstream behavior or fork behavior, stop and ask instead of guessing. `git merge --abort` is always available if the merge turns out to be the wrong move.

## 5. Verify - clean merge or not

A clean textual merge is not a correct merge. Upstream may have renamed an API the fork hooks into, moved a file, or changed behavior a fork feature depends on.

- Run the repo's own checks (typecheck, lint, tests).
- Walk the feature inventory and verify every feature against its verification note: the seams it hooks into still exist and its behavior is intact.
- Fix what broke, keeping the upstream-first priority.

## 6. Report

At the end, summarize what came in from upstream, each conflict and how it was resolved, each fork feature and its verification result, and any open questions that need Connor's call. Leave the result on the working branch; merging it into the fork's main branch is Connor's decision unless already authorized. Build the report with the `/html-communication` skill and give Connor the private URL.
