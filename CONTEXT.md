# Agent Skills

Connor's agent skills, Agent Instructions, and the CLIs they depend on, plus
the installer and the fleetfizz config that ship them to every machine he works on.

## Language

**Live Skill**:
A skill directory under `skills/` with a `SKILL.md`; the only skills an Install installs.
_Avoid_: active skill, published skill

**Agent Instructions**:
The global instructions under `instructions/` that every agent loads: a shared `AGENTS.md`, plus a `*_ONLY.md` that an Install appends to it for one harness.
_Avoid_: memory, rules, system prompt

**Archived Skill**:
A retired skill under `archived/`, kept for reference and never installed.

**Fleet**:
Every macOS and linux Machine on Connor's tailnet.
_Avoid_: devices, hosts, cluster

**Machine**:
One member of the Fleet, identified by its tailnet hostname (e.g. `connors-mac-studio`).
_Avoid_: device, host, box

**Ship**:
A manual run of `pnpm ship` (fleetfizz) that brings every reachable Machine in line with `fleet.config.jsonc`: its vite-plus toolchain and every Tracked Repo, this one included.
_Avoid_: deploy, publish, sync, rollout

**Tracked Repo**:
A git repo that `fleet.config.jsonc` lists, with an origin, a ref, an Install Command, and targeting. This repo and psychopomp are Tracked Repos.
_Avoid_: project, package

**Managed Clone**:
The checkout of a Tracked Repo that fleetfizz owns on one Machine, reset to the repo's origin ref on every Ship. Every Machine, the one starting the Ship included, installs this repo from its Managed Clone.
_Avoid_: mirror, cache, working copy

**Install Command**:
The shell command a Ship runs in a Tracked Repo's Managed Clone to install it. This repo's is `pnpm install --frozen-lockfile && pnpm ship:machine`.
_Avoid_: build script, hook

**Install**:
One run of `pnpm ship:machine`: it brings one Machine's skills, Agent Instructions, and CLIs in line with the checkout it runs from (a Managed Clone, or a working copy when run by hand).
_Avoid_: machine Ship

**Install Manifest**:
A per-Machine record of the skills, and their agents, that Installs currently have installed there, so skills removed from this repo are removed on the next Install.
_Avoid_: install log, history

## Relationships

- A **Ship** runs this repo's **Install Command**, and so one **Install**, on each reachable **Machine** whose **Managed Clone** changed
- Every **Machine** installs from its **Managed Clone** of `origin/main`; nothing installs from a working copy except a hand-run **Install**
- An unreachable **Machine** is skipped with a warning; it never fails the **Ship**

## Example dialogue

> **Dev:** "The Studio was asleep during the last **Ship** - is it stuck on old skills now?"
> **Connor:** "Until the next **Ship**, yes. There's no background sync; a **Ship** only reaches **Machines** that are online."

> **Dev:** "I changed a skill on my branch. Does `pnpm ship` install it?"
> **Connor:** "No, a **Ship** installs `origin/main`. Run `pnpm ship:machine` to **Install** your checkout here; the next `pnpm ship --rebuild connorch-skills` puts main back."

## Flagged ambiguities

- "device" was used for both an OS family (mac/linux) and a specific **Machine** - resolved: OS is a platform; **Machine** always means one named tailnet host.
- "Ship" used to mean both the fleet run and one Machine's run (`ship:fleet` and `ship:machine`) - resolved: a **Ship** is fleetfizz's run across the **Fleet**; one Machine's run of `pnpm ship:machine` is an **Install**.
