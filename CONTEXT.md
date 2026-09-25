# Agent Skills

Connor's agent skills and the CLIs they depend on, plus the tooling that ships
them to every machine he works on.

## Language

**Live Skill**:
A skill directory under `skills/` with a `SKILL.md`; the only skills a Ship installs.
_Avoid_: active skill, published skill

**Archived Skill**:
A retired skill under `archived/`, kept for reference and never installed.

**Fleet**:
Every macOS and linux Machine on Connor's tailnet.
_Avoid_: devices, hosts, cluster

**Machine**:
One member of the Fleet, identified by its tailnet hostname (e.g. `connors-mac-studio`).
_Avoid_: device, host, box

**Ship**:
A manual run that brings Machines' skills and CLIs in line with a source tree; a fleet Ship covers every reachable Machine, a machine Ship covers one.
_Avoid_: deploy, install, publish, sync, rollout

**Managed Clone**:
The per-Machine checkout of this repo that a fleet Ship resets to `origin/main` and ships from.
_Avoid_: mirror, cache

**Install Manifest**:
A per-Machine record of the skills, and their agents, that Ships currently have installed there.
_Avoid_: install log, history

## Relationships

- A fleet **Ship** runs one machine **Ship** on each reachable **Machine** in the **Fleet**
- Other **Machines** ship from their **Managed Clone**; only the **Machine** starting the fleet **Ship** ships its working copy
- An unreachable **Machine** is skipped with a warning; it never fails the fleet **Ship**

## Example dialogue

> **Dev:** "The Studio was asleep during the last **Ship** - is it stuck on old skills now?"
> **Connor:** "Until the next **Ship**, yes. There's no background sync; a **Ship** only reaches **Machines** that are online."

## Flagged ambiguities

- "device" was used for both an OS family (mac/linux) and a specific **Machine** - resolved: OS is a platform; **Machine** always means one named tailnet host.
