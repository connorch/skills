# The Residue Sweep

Mechanical churn artifacts, checked after the shape pass has formed the
verdict. Each check names what to look for, the required empirical
verification, and the legitimate keeps that look like findings but are not.
Aim the sweep with the churn map: files that absorbed the most fix rounds
carry the most residue.

## 1. Dead and orphaned code

A fix that rerouted a call path can strand the old helper, export, or test
fixture behind it. The fix's own diff looks clean; the leftover is only
visible from the end state.

**Check:** for every helper, export, constant, and test fixture the branch
touched or added, map its consumers in the final state with grep, not memory.
Confirm each has at least one live caller outside its own tests. A symbol
whose only remaining references are its definition and its own test is
orphaned.

Also look for:

- imports left behind by a moved or deleted call
- feature flags, env vars, or config keys whose only consumer was removed
- test fixtures and mocks for a code path that no longer exists
- an entire branch of a switch or dispatch table nothing routes to anymore

**Legitimate keeps:** public API exports consumed outside the repo, symbols
referenced only by name in config or generated code (grep the whole tree, not
just source), and deliberate re-exports that form a module's surface.

## 2. Redundant guards left by layered fixes

A later fix can make an earlier guard unreachable. Read in commit order each
guard looks justified; read in the final state one of them is dead.

**Check** the final control flow, not the sequence of diffs that produced it:

- a conditional branch that can no longer be taken
- a defensive check sitting upstream of a stronger check that subsumes it
- a fallback for a state that can no longer occur
- normalization, trimming, or coercion applied twice on one path
- a try/catch around a call that can no longer throw
- an early return duplicated by a validation the caller now performs

**Before deleting a guard**, confirm the stronger check covers *every* entry
point, not just the one the fix came in through. Grep for all callers of the
function containing the guard.

**Legitimate keeps:** a guard that is unreachable today but cheap and
protects an invariant a caller could plausibly violate later - keep it and
add a comment saying which upstream check makes it currently redundant.
Assertions documenting an invariant are also keeps.

Note: *live* duplication - the same guard machinery correct in N places - is
a shape finding, not residue. See shape.md section 4.

## 3. Documentation and comment drift

Docs and comments written early in the branch state claims that later fixes
falsified. These are the cheapest findings to verify and the most damaging to
leave, because they mislead the next reader with authority.

**Check** every checkable claim in the branch's touched docs and comments
against the final code:

- counts: "three guarded spots", "both callers", "two retries"
- lists: files, flags, commands, steps, supported formats
- described behaviors and return shapes
- invariants: "X is the only place that ...", "this always runs before Y"
- code examples whose output the fixes changed
- comments that still describe pre-fix behavior

Every count and every "only" is a claim to grep for. Do not judge these by
reading; run the grep and count.

Also check docs the branch did *not* touch but whose subject it changed - a
README describing a flag whose default a fix flipped is drift even though the
README is not in the diff.

**Legitimate keeps:** clearly-marked aspirational or roadmap statements, and
examples labelled as illustrative rather than as literal output.

## 4. Hardening the fixes themselves forgot

New probes, subprocess calls, and IO added by fixes often lack the robustness
the surrounding code already has. The fix was written to solve one failure,
so its own failure modes went unconsidered.

**For each mechanism a fix ADDED**, ask what happens when it hangs, fails, or
lies:

- missing timeouts on synchronous startup calls, health probes, or network
  reads
- unquoted paths and unescaped interpolation in generated shell commands
- failure directions that default the wrong way: a check that fails open
  where the surrounding code fails closed, or the reverse
- swallowed errors that make a broken state look healthy
- unbounded retries, or no retry where the neighbouring calls have one
- a probe that reports success on partial output
- resources (processes, file handles, temp dirs) with no cleanup on the error
  path

**The bar is the codebase's bar.** Compare against how the existing
surrounding code handles the same class of call rather than an abstract
standard, and match it. Rigor consistency in the other direction - machinery
*over*-guarding declared-harmless state - is a shape finding; see shape.md
section 5.

**Legitimate keeps:** a call whose hang is already bounded by an outer
timeout, and a fail-open default that is deliberate - record why in the
report and, if it is not obvious from the code, in a comment.
