// Turns desired skills plus the Install Manifest into skills CLI operations,
// and folds the outcome back into the next manifest.
//
// The skills CLI cannot remove a single agent reliably: removing `codex`
// leaves the shared ~/.agents copy in place, and removing `claude-code`
// deletes that shared copy from under Codex. So a skill that loses any agent
// is removed entirely, then reinstalled for the agents it keeps. Removals run
// before installs for the same reason.

import { z } from "zod";

// Skill name -> sorted agent slugs. Holds current state, not history.
export const Manifest = z.object({
  version: z.literal(1),
  skills: z.record(z.string(), z.array(z.string())),
});
export type Manifest = z.infer<typeof Manifest>;

export const EMPTY_MANIFEST: Manifest = { version: 1, skills: {} };

export interface InstallGroup {
  agents: string[];
  skills: string[];
}

export interface SkillPlan {
  // Removed from every agent before installs run.
  remove: string[];
  // One skills CLI call per distinct agent set.
  install: InstallGroup[];
  // Desired skills skipped because another source installed that name.
  conflicts: string[];
  // Manifest entries another source has since taken over: dropped, never removed.
  forget: string[];
}

export interface PlanInput {
  // Skill name -> agents it should have here; skills that do not ship here are absent.
  desired: Map<string, string[]>;
  manifest: Manifest;
  // Global lock sources by skill name. Local-path installs never appear here.
  lockSources: Map<string, string>;
  // This repo's source as the lock records it, e.g. `connorch/skills`.
  ownSource: string;
}

export function planSkills({ desired, manifest, lockSources, ownSource }: PlanInput): SkillPlan {
  const foreign = (name: string) => {
    const source = lockSources.get(name);
    return source !== undefined && source !== ownSource;
  };
  const shipping = new Map([...desired].filter(([name]) => !foreign(name)));

  const remove = new Set<string>();
  for (const [name, agents] of Object.entries(manifest.skills)) {
    const keep = shipping.get(name) ?? [];
    if (!foreign(name) && agents.some((agent) => !keep.includes(agent))) remove.add(name);
  }
  // A lock entry from this repo predates Ships (a `skills add connorch/skills`
  // install). Removing it clears the entry, so `skills update` cannot later
  // replace the shipped copy with GitHub's.
  for (const name of shipping.keys()) {
    if (lockSources.get(name) === ownSource) remove.add(name);
  }

  const groups = new Map<string, InstallGroup>();
  for (const [name, agents] of shipping) {
    const key = agents.join(",");
    const group = groups.get(key) ?? { agents, skills: [] };
    group.skills.push(name);
    groups.set(key, group);
  }

  return {
    remove: [...remove].sort(),
    install: [...groups.values()].sort((a, b) => a.agents.join().localeCompare(b.agents.join())),
    conflicts: [...desired.keys()].filter(foreign).sort(),
    forget: Object.keys(manifest.skills).filter(foreign).sort(),
  };
}

// The manifest after a Ship ran the plan. A failed removal keeps its entries
// so the next Ship retries it. Installs are recorded even when they failed, so
// the next Ship can clean up a partial copy.
export function nextManifest(manifest: Manifest, plan: SkillPlan, removed: boolean): Manifest {
  const skills = new Map(
    Object.entries(manifest.skills).map(([name, agents]) => [name, new Set(agents)]),
  );
  for (const name of plan.forget) skills.delete(name);
  if (removed) for (const name of plan.remove) skills.delete(name);
  for (const group of plan.install) {
    for (const name of group.skills) {
      const agents = skills.get(name) ?? new Set();
      for (const agent of group.agents) agents.add(agent);
      skills.set(name, agents);
    }
  }
  return {
    version: 1,
    skills: Object.fromEntries(
      [...skills]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, agents]) => [name, [...agents].sort()]),
    ),
  };
}
