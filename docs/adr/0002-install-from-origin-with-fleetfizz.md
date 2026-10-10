# Install from origin on every Machine, with fleetfizz

A Ship is `pnpm ship`, which runs fleetfizz (an npm devDependency) with `fleet.config.jsonc`
at the repo root. This repo is one Tracked Repo in that config. On every Machine, the one
starting the Ship included, fleetfizz resets a Managed Clone of `origin/main` and, when it
changed, runs this repo's Install Command there: `pnpm install --frozen-lockfile && pnpm
ship:machine`. `apps/ship` is now only that installer. This supersedes ADR 0001's rule that the
starting Machine ships its working copy while every other Machine ships `origin/main`.

## Why

- One rule for every Machine and every repo. Before, what the Studio got depended on which
  branch its working copy was on when someone ran `ship:fleet` there, and outside repos
  (psychopomp, t3code, openwhispr) needed their own package scripts to clone and build them.
- fleetfizz already does the work `ship:fleet` did, for any repo: reaching every Machine over
  Tailscale SSH, skipping offline ones, reporting per Machine, private repo fetches, and the
  vite-plus toolchain. Keeping a second fleet tool here would duplicate it.
- The installer stays in this repo because it knows this repo's layout: Live Skills, the
  Install Manifest, Agent Instructions, and workspace packages' `ship:machine` scripts.

## Considered Options

- **Keep the starting Machine on its working copy (rejected).** A Ship from a feature branch
  would install that branch's skills on the Studio by accident.
- **Keep `ship:fleet` alongside fleetfizz (rejected).** Two tools for the same Ship.

## Consequences

- Nothing installs from a working copy except a hand-run `pnpm ship:machine`. Push to `main`
  before shipping. A hand install stays until `pnpm ship --rebuild connorch-skills`, because
  the Managed Clone's commit has not changed.
- fleetfizz passes the Machine to the installer as `FLEETFIZZ_MACHINE`, `FLEETFIZZ_PLATFORM`,
  and `FLEETFIZZ_MACHINES`. Run by hand, the installer reads `tailscale status --json`.
- The `fleet: false` targeting control is gone: there is no special starting Machine to ship
  only to. Use `machines` instead.
- psychopomp is a Tracked Repo pinned to a commit. Its Install Command links
  `~/.local/share/psychopomp` to its Managed Clone, so the motion-explainer skill keeps its path.
- Upgrading fleetfizz means bumping it in the pnpm catalog. Its CLI and the JSON Schema that
  `fleet.config.jsonc` is checked against are always the same version.
- fleetfizz never deletes. Managed Clones and records of repos removed from the config stay
  until someone removes them by hand.
