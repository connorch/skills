<!-- @airef caution -->

# QA UX Plan Output

Use this reference only when the source plan was produced by `$qa-ux-plan` or
matches its output structure.

## Section Mapping

- **Summary:** Use as the product intent and scope guard. Do not invent broader
  requirements outside the summarized branch behavior.
- **Changed Surface Area:** Use the area, files/routes, user-facing impact, and
  risk columns to prioritize scenario order and identify likely code owners.
- **Assumptions:** Convert into setup prerequisites. If an assumption cannot be
  satisfied, log it as a setup blocker or ambiguity before testing dependent
  scenarios.
- **Critical Happy Paths:** Execute as primary scenarios. Preserve each
  scenario's priority, user goal, preconditions, steps, expected outcome, and
  regression risk in the issue log when failures occur.
- **Edge Cases and Negative Cases:** Execute after happy paths for the same
  changed area so root-cause related issues can be grouped.
- **Regression Checks:** Treat as required coverage for the Regression Evaluator
  when a fix touches nearby flows.
- **Responsive and Cross-Device Checks:** Assign to the UX Evaluator. Use at
  least one narrow mobile viewport and one desktop viewport when layout,
  navigation, tables, modals, or forms are involved.
- **Accessibility and Usability Checks:** Add the Accessibility Evaluator when
  this section contains concrete checks or when observed failures involve
  focus, keyboard flow, labels, disabled states, contrast, or error messaging.
- **Prioritized Smoke Test:** Run first during baseline to expose blockers
  early, then rerun after every P0/P1 fix and during the final full rerun.
- **Out of Scope:** Do not fix or expand testing into these areas unless a
  failure blocks an in-scope scenario.
- **Handoff Notes:** Use as ambiguity and judgment guidance. Promote unresolved
  ambiguity to the issue log instead of silently choosing a product behavior.

## Execution Order

Prefer this execution order for `$qa-ux-plan` output:

1. Validate assumptions and setup.
2. Run the prioritized smoke test.
3. Run P0 critical happy paths.
4. Run P1/P2 critical happy paths.
5. Run edge and negative cases grouped by affected area.
6. Run regression checks for touched or suspect nearby flows.
7. Run responsive, cross-device, accessibility, and usability checks.
8. Re-run the full plan after all fixes pass evaluator signoff.

## Issue Conversion

When turning a failed scenario into an issue, copy the scenario title into the
issue title when possible and include:

- source section name
- priority from the plan
- user goal
- preconditions and data assumptions
- failed step number
- expected outcome
- regression risk covered
- changed surface area row that appears related
