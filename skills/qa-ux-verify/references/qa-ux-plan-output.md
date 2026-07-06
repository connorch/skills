<!-- @airef caution -->

# QA UX Plan Output

Use this reference only when the source plan was produced by `$qa-ux-plan` or
matches its output structure.

## Section Mapping

- **Summary:** Use as the product intent and scope guard. Do not invent broader
  requirements outside the summarized branch behavior.
- **Changed Surface Area:** Use the area, files/routes, user-facing impact, and
  risk columns to prioritize scenario order and identify likely code owners or
  suspected surfaces for findings.
- **Assumptions:** Convert into setup prerequisites. If an assumption cannot be
  satisfied, log it as a setup blocker or ambiguity before testing dependent
  scenarios.
- **Critical Happy Paths:** Execute as primary scenarios. Preserve each
  scenario's priority, user goal, preconditions, steps, expected outcome, and
  regression risk in the run log and HTML report.
- **Edge Cases and Negative Cases:** Execute after happy paths for the same
  changed area so related failures can be grouped.
- **Regression Checks:** Treat as required coverage for nearby flows affected by
  the changed surface area.
- **Responsive and Cross-Device Checks:** Use at least one narrow mobile viewport
  and one desktop viewport when layout, navigation, tables, modals, or forms are
  involved.
- **Accessibility and Usability Checks:** Execute concrete checks for keyboard
  flow, focus states, labels, disabled states, error messaging, contrast, and
  assistive-technology-relevant copy when inferable from the plan.
- **Prioritized Smoke Test:** Run first to expose blockers early.
- **Out of Scope:** Do not expand testing into these areas unless a failure
  blocks an in-scope scenario. Record any intentionally skipped out-of-scope item
  as `skipped` only when it appears in the requested plan.
- **Handoff Notes:** Use as ambiguity and judgment guidance. Promote unresolved
  ambiguity to the run log instead of silently choosing a product behavior.

## Execution Order

Prefer this execution order for `$qa-ux-plan` output:

1. Validate assumptions and setup.
2. Run the prioritized smoke test.
3. Run P0 critical happy paths.
4. Run P1/P2 critical happy paths.
5. Run edge and negative cases grouped by affected area.
6. Run regression checks for touched or suspect nearby flows.
7. Run responsive and cross-device checks.
8. Run accessibility and usability checks.

## Finding Conversion

When turning a failed scenario into a finding, copy the scenario title into the
finding title when possible and include:

- source section name
- priority from the plan
- user goal
- preconditions and data assumptions
- failed step number
- expected outcome
- actual observed outcome
- regression risk covered
- changed surface area row that appears related
- browser evidence paths
