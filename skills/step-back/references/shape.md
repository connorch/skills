# The Shape Pass

This pass forms the architectural verdict. Run it before the residue sweep,
with the whole diff and the branch's design docs already read. The output is
judgment, not a checklist result - but each question below has a method, and
the verdict must be traceable to evidence from the final state.

## 1. Judge the big calls on their merits

List the branch's major decisions: package and module boundaries, schema
shape, state and derivation model, storage layout, sync vs async, where the
source of truth lives. For each one:

- Is it argued anywhere (ADR, design doc, comment)? Does the argument hold
  against the final code, or did later fixes quietly falsify it?
- What is the strongest alternative, and does the chosen call beat it? Name
  the property the decision buys - "makes the race unrepresentable",
  "mirrors the existing sibling package", "deletes a class of bookkeeping".
  If you cannot name the property, the call may be habit rather than design.

Being deliberate is not the same as being right: an ADR that acknowledges a
wart records the cost, it does not neutralize it. Re-price acknowledged
trade-offs against the final state, where their true cost is visible.

## 2. Invariant erosion

Extract the branch's stated invariants: purity and determinism claims,
layering rules, "X is the only place that", "always"/"never" statements in
ADRs and load-bearing comments. Then hunt for exceptions the iteration
threaded through them.

The tells:

- a parameter threading through several signatures to serve one small feature
- a function documented as pure or canonical that grew a viewer, workspace, or
  request-context dependency
- a special case inside a general mechanism, added where a bug was reported
- an output or hash that now depends on who is asking

Price each exception: how much conceptual damage per unit of feature value?
An invariant pierced across five signatures to render one line of text is a
bad trade even if every individual diff looked reasonable.

An exception is a **walk-back candidate** when the cost clearly exceeds the
value *and* the codebase already has a pattern that absorbs the same need - a
notice or banner instead of viewer-dependent output, a lazy recompute instead
of threaded state, a follow-up job instead of an inline special case. Propose
that existing pattern by name; a walk-back with no landing spot is just a
complaint.

## 3. Placement and sharing

Check each function the branch added or moved against the boundaries the
codebase already has:

- Does core code now know about app, CLI, or presentation concerns?
- Does an entry point duplicate something a shared module already owns?
- Did two separate fixes solve the same problem in two different places?
- Did a helper get defined next to its first caller when a second caller now
  exists in a different module?

Then check the opposite failure, which is the more expensive mistake: things
that **look** like duplication but are genuinely distinct concerns sharing a
name or shape - two `normalizePath` functions where one handles user input
and the other handles values already validated upstream. Do not merge those;
confirm each site's comments make the distinction explicit, and add the
clarification if missing.

**Deciding between them:** would a future requirement change need to change
both sites in the same way? If yes, it is duplication. If a plausible change
hits one and not the other, they are distinct.

## 4. Live duplication from hardening rounds

Review rounds harden site-by-site: each round adds the same guard machinery
at whichever site it reviewed - lock, re-read, recompute, compare; retry
wrappers; cleanup-on-failure; revalidation before write. Every copy is live
and locally correct, which is why per-fix review never flags it. This is the
signature artifact of iteration, distinct from the residue sweep's *dead*
redundancy.

**Check:** for each defensive pattern the branch's new code contains, grep
for its shape across the branch and count the copies. Three or more copies of
one concurrency or safety invariant - especially when the same invariant is
explained in a comment at each site - want a single helper that owns the
invariant, its comment, and its future fixes. One copy per genuine variation
is fine; N copies per review round is accretion.

## 5. Rigor consistency

The branch's effort should match its own declared stakes, in both directions.

**Over-rigor:** machinery eagerly guarding state the branch elsewhere calls
harmless, inert, or self-healing. Count the call sites and the per-call cost
(extra hooks every future route must remember, a full recompute per
mutation). If the failure mode of removing the machinery is benign *by the
branch's own design* - invisible state, healed on next use - propose the lazy
path and delete the eager one. Rigor spent on declared-harmless states is
rigor stolen from real risks.

**Under-rigor:** map the churn concentration from step 1's log against test
coverage. Paths that absorbed many fix rounds hold hard-won complexity -
concurrency guards, freshness gates, cleanup-on-failure - and if they are
untested, the debugging that produced them will be repeated by the next
change. Watch for the classic asymmetry: a well-tested pure package next to
an untested service that hosts all the actual difficulty. Where the repo
already proves such tests are feasible (a sibling service with tests), say
so; it converts "add tests someday" into a concrete gap.

## 6. Forward fit

Judge the end state against what comes next:

- If a roadmap or later phases exist (in the ADR, the tracker, or the user's
  framing), do they consume this branch's foundations unchanged, or will they
  force rework? Foundations that survive the roadmap are the strongest
  evidence of an optimal end state.
- Does per-request work scale with the data (full plan recompute on every
  list call, N+1 loads) on a path that is or will be perf-sensitive? Note it
  with its trigger condition rather than speculating - "fine at current
  scale, revisit when X" is the honest form.
- Did the branch take on a standing obligation - a patched dependency, a
  manual version bump, a convention every future route must follow - and is
  that obligation recorded anywhere a future contributor will see it?
