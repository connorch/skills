---
name: qa-ux-fix-loop
description: >-
  Use when asked to execute a QA guide, QA plan, PR QA checklist, UX test plan,
  end-to-end verification guide, browser-based product test plan, or output from
  the qa-ux-plan skill and then record, fix, and re-verify discovered
  issues. Applies to workflows that should iterate through evaluator-generator
  negotiation, implementation, evaluator signoff, serial issue fixing, final
  full QA reruns, and high confidence code quality for user-facing changes.
---

# QA UX Fix Loop

## Overview

Execute a QA plan as a discovery-and-repair loop: validate the product, capture
each issue with evidence, fix issues serially, require evaluator signoff, and
rerun the plan until no actionable issues remain.

Prefer real tools and observable evidence over speculation. Use separate agent
sessions, threads, or worktrees when available; otherwise run the same roles
sequentially in the main thread and clearly label each role's output.

## Core Loop

1. **Orient**
   - Read the requested QA guide or plan completely.
   - If the input appears to be output from `$qa-ux-plan`, read
     `references/qa-ux-plan-output.md` and use that mapping to normalize the
     plan before execution.
   - Create or choose an artifact directory before browser testing starts.
     Prefer `.context/qa-ux-artifacts/` when working in a repo.
   - Prepare a screenshot capture plan from the QA guide's steps, expected
     assertions, responsive checks, and likely failure points.
   - Inspect repo instructions, app startup steps, browser automation guidance,
     and changed files relevant to the QA plan.
   - If the repo includes browser automation instructions, read and follow them
     for UX verification.
   - Start or reuse the local app only when needed for the plan.

2. **Baseline QA pass**
   - Execute the QA plan end to end before fixing anything, unless setup is
     blocked.
   - Take screenshots at every important browser-visible step:
     - app ready/setup complete
     - start of each user flow or scenario
     - each assertion point where visible UI proves success or failure
     - every unexpected state, error, layout defect, or blocked step
     - before and after each fix verification for UI issues
     - final comprehensive rerun completion
   - Record every issue in a durable issue log with:
     - title, severity, affected flow, repro steps, expected behavior, actual
       behavior, environment, evidence, and suspected surface area
     - links to screenshots, traces, logs, failing tests, or terminal output when
       available
   - Deduplicate issues by root cause when evidence supports doing so.
   - Separate product bugs from setup gaps, ambiguous requirements, flaky tests,
     and out-of-scope findings.

3. **Triage**
   - Sort issues by user impact, blocking severity, and dependency order.
   - Fix issues serially. Do not start overlapping fixes that could touch the
     same files, flows, data contracts, or tests.
   - For each issue, create or branch to a dedicated working thread when the
     environment supports it. Pass only the issue statement, repro evidence, and
     relevant constraints to that thread.

4. **Evaluator negotiation**
   - Run this negotiation separately for each issue after triage and before that
     issue's implementation. Do not reuse success criteria from prior issues
     unless they are still directly applicable.
   - Before implementation, have the generator and required evaluators agree on
     concrete success criteria.
   - Always include:
     - **Code Evaluator:** correctness, maintainability, local patterns, tests,
       edge cases, no loose ends, no unrelated churn.
     - **UX Evaluator:** user-visible behavior, browser automation evidence,
       responsive states, loading/error/empty states, and copy clarity.
   - Add specialist evaluators only when the issue touches that risk:
     - **Accessibility Evaluator:** keyboard flow, focus management, labels,
       ARIA, contrast, screen-reader-relevant copy.
     - **Data/API Evaluator:** persistence, migrations, API contracts, auth,
       permissions, caching, background jobs, external integrations.
     - **Security/Privacy Evaluator:** authorization, sensitive data exposure,
       injection surfaces, unsafe redirects, logging of private data.
     - **Performance Evaluator:** slow queries, render loops, excessive network
       calls, bundle size, large data sets, expensive browser work.
     - **Regression Evaluator:** nearby flows, compatibility, existing tests,
       backward-compatible behavior, feature flags, rollout risk.
   - Keep negotiated criteria short, testable, and evidence-based. Do not accept
     vague criteria such as "works well" or "looks good."

5. **Generate the fix**
   - Reproduce or inspect enough to identify the root cause before editing.
   - Make the smallest comprehensive fix that satisfies all negotiated criteria.
   - Follow existing code style, architecture, design system, and test patterns.
   - Add or update automated tests when they materially reduce regression risk.
   - Avoid unrelated refactors, formatting churn, dependency changes, and broad
     rewrites unless required by the fix.

6. **Evaluator signoff**
   - Run the agreed verification for each evaluator.
   - The UX evaluator must use browser automation for browser-testable UI issues
     and provide concrete evidence: screenshots, recorded steps, console/network
     observations, or DOM assertions.
   - The code evaluator must inspect the diff and run relevant tests, linters, or
     type checks when available.
   - Specialist evaluators must validate their negotiated criteria with commands,
     browser evidence, source inspection, or documented reasoning.
   - If any evaluator fails, record the failed criterion and return to generation
     for the same issue. Renegotiate only when the original criterion was wrong
     or incomplete.
   - Move to the next issue only after all required evaluators pass.

7. **Final comprehensive rerun**
   - After all logged issues pass, rerun the original QA guide from the start.
   - Record new findings, then repeat the loop for those findings.
   - Update the single required HTML report, `qa-ux-report.html`, from the
     latest evidence before finishing. Do not create separate success and
     failure reports.
   - The report must show which full e2e loop number found each issue or
     success state. Loop #1 is the first complete e2e pass, loop #2 is the
     next complete pass after fixes, and so on.
   - When a later loop changes the outcome for a scenario, update that
     scenario's existing report section with the new evidence instead of
     creating a duplicate section elsewhere.
   - Finish only when the full rerun passes or remaining items are explicitly
     blocked, out of scope, or accepted as known issues.

## HTML Report Artifacts

Always produce one HTML report when browser automation was part of the QA run.
Prefer writing them under `.context/qa-ux-artifacts/` with screenshots in
`.context/qa-ux-artifacts/screenshots/`.

- **`qa-ux-report.html`:** The single source of truth for the full fix-loop
  run. Track every e2e scenario, including scenarios that passed initially,
  scenarios that failed and were fixed, blocked setup items, accepted known
  issues, and out-of-scope findings. The top summary should make the current
  state obvious without requiring another document.
- Create one section per stable e2e scenario. Use a durable scenario ID, such as
  `SCENARIO-001: Checkout payment recovery`, and keep updating that same section
  across loops.
- Each scenario section must contain the full lifecycle for that scenario:
  - source plan section, scenario name, viewport/device, environment, and current
    status
  - per-loop timeline entries showing loop number, date/time when useful,
    result, evidence paths, and whether the scenario stayed successful, newly
    failed, remained failing, or was fixed
  - if the scenario passed on loop #1, state that it was initially successful
    and include the success evidence
  - if the scenario failed, include severity, failed step, expected vs actual
    behavior, suspected surface area, issue-state screenshot, and repro evidence
  - after a fix, include the fix summary, files changed when useful, isolated
    fix commit hash, evaluator signoff, commands run, and success-state
    screenshot
  - if the same scenario fails again in a later loop, append that loop's issue
    state, fix evidence, and new isolated fix commit hash in the same section
- Keep screenshot links external instead of base64 by default so users can
  inspect images directly.
- In the generated HTML report, make every visible screenshot preview clickable
  by wrapping it in a link to the same PNG file, for example:
  ```html
  <a class="screenshot-link" href="screenshots/001-loop-01-smoke-dashboard-desktop-pass.png">
    <img src="screenshots/001-loop-01-smoke-dashboard-desktop-pass.png" alt="Loop #1 dashboard pass screenshot">
  </a>
  ```
  Opening the link should navigate to the standalone PNG/fullscreen browser view.

Name screenshots with a sortable prefix, loop number, scenario slug, viewport
when relevant, and status, for example:

```text
.context/qa-ux-artifacts/screenshots/
  001-loop-01-smoke-dashboard-desktop-pass.png
  014-loop-01-checkout-payment-desktop-fail.png
  021-loop-02-checkout-payment-mobile-fixed-pass.png
```

Use `references/html-showcase-example.html` as the visual structure to follow
when building the report. Adapt the styling to the project when useful, but
preserve the evidence-first content model.

## Fix Commits

Each fix must be committed independently before moving to the next issue unless
the user explicitly forbids commits. Keep each commit scoped to one root cause or
one tightly coupled e2e scenario. Do not batch unrelated fixes into one commit.

After each isolated fix commit:

- record the commit hash in the issue log
- record the same commit hash in the matching `qa-ux-report.html` scenario
  section
- link the commit to the loop number where the issue was found and the loop
  number where the fix was verified
- if a fix cannot be committed, record why in the issue log and report section

## Issue Log Format

Use a durable log in the workspace, PR notes, or the conversation. Prefer a
workspace-local file such as `.context/qa-ux-fix-loop.md` when working in a repo.

```md
# QA UX Fix Loop

## Source Plan
- Plan:
- Environment:
- App URL:
- Browser automation guidance:
- Artifact directory:
- HTML report: .context/qa-ux-artifacts/qa-ux-report.html

## E2E Loops

### Loop 1: <date/time or run label>
- Scope:
- Result summary:
- Evidence added:

### Loop 2: <date/time or run label>
- Scope:
- Result summary:
- Evidence added:

## Test Scenarios

### SCENARIO-001: <scenario name>
- Source plan section:
- Current status: initially-passed | failed-then-fixed | still-failing | blocked | out-of-scope | accepted-known-issue
- First observed in loop:
- Last verified in loop:
- Environment:
- Viewports/devices:
- Loop evidence:
  - Loop 1:
    - Result:
    - Evidence:
    - Screenshots:
  - Loop 2:
    - Result:
    - Evidence:
    - Screenshots:
- Issue state:
  - Severity:
  - Failed step:
  - Expected:
  - Actual:
  - Suspected surface:
- Fix lifecycle:
  - Fix summary:
  - Isolated fix commit:
  - Files changed:
  - Verification commands:
  - Evaluator signoff:
- Follow-ups:

## Issues

### ISSUE-001: <title>
- Severity: P0/P1/P2/P3
- Status: discovered | negotiating | fixing | evaluating | passed | blocked | out-of-scope
- Affected flow:
- Repro:
- Expected:
- Actual:
- Evidence:
- Screenshots:
- Suspected surface:
- Required evaluators:
- Success criteria:
- Fix summary:
- Isolated fix commit:
- Verification evidence:
- Follow-ups:
```

## Severity Guide

- **P0:** blocks core flow, data loss, security/privacy exposure, or crash.
- **P1:** major user-facing feature broken, no reasonable workaround.
- **P2:** degraded experience, confusing UX, broken edge case, workaround exists.
- **P3:** polish issue, minor copy/layout defect, low-risk inconsistency.

## Evidence Rules

- Do not mark an issue fixed based only on code inspection when the behavior can
  be tested.
- Do not mark UX signoff complete without browser-visible evidence for UI bugs.
- Do not complete a browser-based QA run without a current `qa-ux-report.html`
  report.
- Do not bury failed visual evidence only in chat. Link each failed browser step
  from the report and issue log.
- Do not list a scenario as successful unless a screenshot, DOM assertion,
  trace, or equivalent browser observation proves the checked state.
- Do not split QA evidence into separate success and failure documents.
- Do not leave an issue-state section without the corresponding fix evidence
  once the fix has been verified.
- Do not omit the isolated fix commit hash from a fixed scenario unless a commit
  was impossible or explicitly disallowed, and then record why.
- Do not mark code signoff complete without reviewing the actual diff.
- Capture exact commands run and the relevant pass/fail result.
- If a tool cannot be run, state why and use the next strongest verification
  available.

## Final Response

Report:

- source QA plan used
- issues found and final status
- HTML report path and screenshot artifact directory
- isolated fix commits
- files changed
- verification commands and browser checks performed
- remaining risks, blocked items, or accepted out-of-scope findings
