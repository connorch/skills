# TypeScript port of bambu-studio-ai, with upstream vendored as a reference

The `bambu` CLI takes its model-preparation features (Search, Generate, Make,
Printability Report, painting, slicing, status, watching) from
[heyixuan2/bambu-studio-ai](https://github.com/heyixuan2/bambu-studio-ai), a
Python agent skill. We port it to TypeScript inside `apps/bambu-cli` instead of
installing the Python skill, because this repo is TypeScript-only, the port can
share one CLI with the printer half, and upstream's design (the user downloads
every Model and starts every print by hand) is the opposite of what the skill
is for here. Where upstream and the pre-existing `bambu` CLI overlapped, upstream's
behaviour won: it is the more considered and the only tested one.

Upstream stays in the repo as a plain copy at `vendor/bambu-studio-ai`, excluded
from lint, typecheck, and Ship. It is a reference, not a dependency: replacing the
copy at a newer upstream commit gives one diff that is the list of features to
consider porting by hand. `vendor/README.md` records the commit the port tracks
and the update recipe. It was first added as a squashed `git subtree`; that was
dropped because the subtree's parentless squash commit cannot be rebased across,
and upstream's history buys nothing for a copy we never edit. Delete the folder
when we stop tracking upstream.

## Considered Options

- **Install the Python skill as-is (rejected).** Would need a Python environment on
  the Studio and a second place to make changes; its refusal to download or print
  would need patching anyway.
- **Fork upstream and ship from the fork (rejected).** Same Python problem, and the
  changes we need (unattended printing, downloads) would never merge back, so the
  fork's main advantage does not apply.
- **Subtree inside `skills/` and merge upstream's Python directly (rejected).** Only
  works while we leave their code untouched, which a TypeScript port cannot do.

## Consequences

- Upstream's tests and recorded fixtures are the port's specification; each ported
  area carries them over as `vp test` suites.
- The port is a derivative of an MIT project: `THIRD_PARTY_NOTICES.md` keeps
  upstream's licence notice.
- Features upstream removed on purpose (printer write paths, camera, FTP) are
  exactly the ones this repo keeps from its own CLI; the two halves do not overlap.
