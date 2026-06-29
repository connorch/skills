---
name: qa-ux-plan
description: >-
  Use when asked to create an end-to-end QA or UX verification plan for the
  current Git branch, especially from branch diffs, changed files, product
  flows, routes, screens, components, API changes, copy, styles, or config.
---

# QA UX Plan

## Purpose

Generate a clear, handoff-ready QA plan from the current branch. Do not run
tests, write test code, propose fixes, or describe execution mechanics unless
the user explicitly asks.

The plan is product- and UX-focused: what changed, which flows may be affected,
what should be verified, expected outcomes, and nearby regressions to watch.

## Example Invocation

> Use the QA UX plan skill to generate an end-to-end QA plan for the
> current branch.

## Inspection Flow

1. Check repository state:
   - `git status`
   - current branch name
   - base branch from repo context; use `main` if no better signal exists
2. Inspect the branch diff against the base branch.
3. Review changed files and classify them:
   - user-facing routes, pages, screens, components, layouts, forms, modals,
     navigation, styles, copy, config, and feature flags
   - backend behavior visible to users, including API handlers, server actions,
     schemas, migrations, permissions, auth, data loading, errors, and external
     integrations
   - tests, docs, build tooling, or internal-only changes as supporting context
4. Read relevant product docs, README files, route maps, or existing tests only
   when they clarify intended behavior.
5. Infer impacted product areas, routes, screens, flows, components, data
   states, account roles, and settings.
6. Separate directly changed behavior from likely regression surfaces.
7. Produce the QA plan using the template below.

## Planning Rules

- Keep the plan execution-tool-agnostic.
- Do not include tool-specific execution instructions or implementation-level
  testing mechanics.
- Prefer concrete user scenarios over generic checklist items.
- Mark inferred behavior explicitly when it is not directly visible in the diff.
- Do not assume every changed file is user-facing; identify internal-only or
  infrastructure-only changes separately.
- Include setup and data assumptions.
- Prioritize scenarios as P0, P1, or P2.
- Include expected outcomes for each scenario.
- Include edge cases, negative cases, regression checks, responsive checks, and
  accessibility or usability checks when relevant to the diff.
- Include a short smoke-test subset.
- Include out-of-scope areas when inferable.
- Do not recommend implementation changes unless the user asks for fixes.

## Output Template

```md
# QA UX Plan: <branch or feature name>

## 1. Summary

Brief summary of the branch's user-facing changes.

## 2. Changed Surface Area

| Area | Files / Routes | User-facing impact | Risk |
|---|---|---|---|

## 3. Assumptions

- Base branch:
- Environment:
- Required data:
- Feature flags:
- Auth/account assumptions:
- External service assumptions:

## 4. Critical Happy Paths

### Scenario 1: <name>

**Priority:** P0/P1/P2
**User goal:**
**Preconditions:**
**Steps:**
1.
2.
3.

**Expected outcome:**
-

**Regression risk covered:**
-

## 5. Edge Cases and Negative Cases

Use the same scenario format, focused on validation, empty states, errors,
permissions, loading states, retries, stale data, and boundary conditions.

## 6. Regression Checks

List nearby flows that were not directly changed but may be affected.

## 7. Responsive and Cross-Device Checks

Include only relevant checks. Focus on viewport and layout behavior,
navigation, forms, modals, tables, overflow, and touch usability.

## 8. Accessibility and Usability Checks

Include keyboard flow, focus states, labels, disabled states, error messaging,
contrast concerns, and assistive-technology-relevant copy where inferable.

## 9. Prioritized Smoke Test

A short subset of the most important checks to run first.

## 10. Out of Scope

List areas that do not need testing based on the diff, if inferable.

## 11. Handoff Notes

Concise notes for the QA agent, including ambiguity, areas requiring judgment,
and anything that could not be inferred from code.
```

## Example Output Outline

```md
# QA UX Plan: checkout-address-validation

## 1. Summary

This branch appears to update checkout address validation and error copy.

## 2. Changed Surface Area

| Area | Files / Routes | User-facing impact | Risk |
|---|---|---|---|
| Checkout shipping form | `app/checkout/...` | New validation states and copy | High |

## 4. Critical Happy Paths

### Scenario 1: Complete checkout with a valid shipping address

**Priority:** P0
**User goal:** Submit shipping details and continue payment.
**Preconditions:** User has an item in cart and is signed in.
**Steps:**
1. Open checkout.
2. Enter a complete valid shipping address.
3. Continue to payment.

**Expected outcome:**
- The user reaches payment without validation errors.

**Regression risk covered:**
- Existing valid checkout flow still works after validation changes.
```
