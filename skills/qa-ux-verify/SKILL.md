---
name: qa-ux-verify
description: >-
  Use when asked to execute, validate, test, or browser-check a QA guide,
  QA plan, PR QA checklist, UX test plan, browser-based product test plan, or
  output from the qa-ux-plan skill and generate an evidence-backed HTML report
  without fixing product issues. Applies to workflows that should run browser
  automation across every planned scenario, capture screenshots and observable
  results, classify pass/fail/blocked/skipped outcomes, and produce a
  qa-ux-report.html artifact similar to qa-ux-fix-loop reports.
---

# QA UX Verify

## Overview

Execute a QA plan as a read-only browser verification pass: validate every
planned user-facing scenario, capture concrete evidence, classify outcomes, and
write a single HTML report. Do not fix discovered issues unless the user
explicitly changes the task.

Prefer real browser automation, screenshots, DOM assertions, console/network
observations, and command output over speculation. If separate browser agents or
sessions are unavailable, run the checks sequentially in the main thread and
label the evidence clearly.

## Core Workflow

1. **Orient**
   - Read the requested QA guide or plan completely.
   - If the input appears to be output from `$qa-ux-plan`, read
     `references/qa-ux-plan-output.md` and use that mapping to normalize the
     plan before execution.
   - Create or choose an artifact directory before browser testing starts.
     Prefer `.context/qa-ux-artifacts/` when working in a repo.
   - Prepare a screenshot capture plan from each scenario's steps, expected
     assertions, responsive checks, accessibility/usability checks, and likely
     failure points.
   - Inspect repo instructions, app startup steps, browser automation guidance,
     and changed files relevant to the QA plan.
   - If the repo includes browser automation instructions, read and follow them.
   - Start or reuse the local app only when needed for the plan.

2. **Normalize scenarios**
   - Convert the source plan into stable scenario IDs such as
     `SCENARIO-001: Checkout payment recovery`.
   - Preserve source section, priority, user goal, preconditions, steps,
     expected outcome, regression risk, viewport/device requirements, and setup
     assumptions.
   - Include all in-scope plan sections: smoke tests, critical happy paths, edge
     cases, negative cases, regression checks, responsive checks, accessibility
     checks, and usability checks.
   - Mark genuinely untestable items as `blocked`, `skipped`, or
     `needs-human-review`; do not silently drop them.

3. **Execute browser verification**
   - Run the prioritized smoke test first when the plan provides one.
   - Then execute all remaining in-scope scenarios in priority order.
   - Use browser automation for browser-testable UI checks. Capture:
     - app ready/setup complete
     - start of each user flow or scenario
     - each visible assertion point proving success or failure
     - every unexpected state, error, layout defect, inaccessible control, or
       blocked step
     - responsive viewport evidence when the plan calls for it
     - final state for each scenario
   - Observe and record console errors, relevant network failures, URL changes,
     visible loading/error/empty states, focus behavior, keyboard flow, labels,
     disabled states, and copy where relevant.
   - Do not edit product code, apply fixes, commit changes, or negotiate fix
     criteria. Artifact files created for the QA run are allowed.

4. **Classify outcomes**
   - Classify each scenario as:
     - `passed`: all expected outcomes were verified with evidence
     - `failed`: a product issue or UX defect prevented the expected outcome
     - `blocked`: setup, data, auth, dependency, or environment prevented a fair
       test
     - `skipped`: explicitly out of scope, not applicable, or not reachable in
       the current environment
     - `needs-human-review`: subjective judgment, visual polish, copy approval,
       or external behavior requires a human decision
   - For failures, record severity, failed step, expected behavior, actual
     behavior, environment, evidence, and suspected surface area.
   - Separate product bugs from setup gaps, ambiguous requirements, flaky
     behavior, and out-of-scope findings.
   - Deduplicate repeated failures only when evidence supports a shared root
     cause, while preserving every affected scenario in the report.

5. **Produce artifacts**
   - Maintain a durable run log. Prefer
     `.context/qa-ux-artifacts/qa-ux-verify.md`.
   - Always produce one HTML report when browser automation was part of the QA
     run. Prefer `.context/qa-ux-artifacts/qa-ux-report.html`.
   - Place screenshots under `.context/qa-ux-artifacts/screenshots/`.
   - Use `references/html-showcase-example.html` as the visual structure to
     follow. Preserve the evidence-first layout and omit repair lifecycle fields
     unless the source plan already includes known issue context.
   - Keep screenshot links external instead of base64 by default so users can
     inspect images directly.

## HTML Report Requirements

The report is the single source of truth for the browser QA run. The top summary
must make the current state obvious without requiring another document:

- source plan name or branch
- app URL and environment
- date/time of the run when useful
- total scenarios
- counts for passed, failed, blocked, skipped, and needs-human-review
- high-impact findings and setup blockers

Create one section per stable scenario. Each scenario section must contain:

- scenario ID and name
- source plan section, priority, viewport/device, environment, and current status
- preconditions and steps actually attempted
- expected outcome and observed outcome
- evidence paths, including screenshots, traces, logs, console/network notes, or
  DOM assertions where available
- for passes: the verified success state and screenshot evidence
- for failures: severity, failed step, expected vs actual behavior, suspected
  surface area, repro notes, and issue-state screenshot
- for blockers/skips: exact blocker, what was attempted, what evidence exists,
  and what would be needed to complete the check
- for needs-human-review: the judgment needed, options when obvious, and
  evidence that supports review

Name screenshots with a sortable prefix, scenario slug, viewport when relevant,
and status, for example:

```text
.context/qa-ux-artifacts/screenshots/
  001-smoke-dashboard-desktop-pass.png
  014-checkout-payment-desktop-fail.png
  021-settings-permissions-mobile-blocked.png
```

## Run Log Format

Use this structure for `.context/qa-ux-artifacts/qa-ux-verify.md` when a
workspace-local log is appropriate:

```md
# QA UX Verify

## Source Plan
- Plan:
- Environment:
- App URL:
- Browser automation guidance:
- Artifact directory:
- HTML report: .context/qa-ux-artifacts/qa-ux-report.html

## Run Summary
- Started:
- Completed:
- Scope:
- Result summary:
- Evidence added:

## Test Scenarios

### SCENARIO-001: <scenario name>
- Source plan section:
- Priority:
- Current status: passed | failed | blocked | skipped | needs-human-review
- Environment:
- Viewports/devices:
- Preconditions:
- Steps attempted:
- Expected:
- Observed:
- Evidence:
- Screenshots:
- Console/network notes:
- Accessibility/usability notes:
- Follow-ups:

## Findings

### FINDING-001: <title>
- Severity: P0/P1/P2/P3
- Status: open | blocked | needs-human-review | out-of-scope
- Affected scenario:
- Failed step:
- Repro:
- Expected:
- Actual:
- Evidence:
- Suspected surface:
- Notes:
```

## Completion Criteria

Finish only after every in-scope scenario from the source plan is represented in
the HTML report with evidence and a clear status. In the final response, provide
the report path, artifact directory, app URL tested, and a concise outcome
summary. Mention that no product fixes were made.
