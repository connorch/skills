// Targeting controls: where a Live Skill or a workspace package ships.
//
// Skills declare them under `metadata` in SKILL.md frontmatter; packages under
// a `ship` key in package.json. Both use the same fields and defaults, except
// that only skills choose agents. Every field is optional and the fields
// combine with AND: a Machine gets the item only if it passes all of them.

import { z } from "zod";

const PLATFORMS = ["darwin", "linux"] as const;
export type Platform = (typeof PLATFORMS)[number];

const DEFAULT_AGENTS = ["claude-code", "codex"];

const nonEmptyList = z.array(z.string().min(1)).nonempty();

export const PackageControls = z.object({
  platforms: z
    .array(z.enum(PLATFORMS))
    .nonempty()
    .default([...PLATFORMS]),
  // Tailnet short names, e.g. connors-mac-studio. Unset means every Machine.
  machines: nonEmptyList.optional(),
  // false: ship only to the Machine that started the Ship.
  fleet: z.boolean().default(true),
});
export type PackageControls = z.infer<typeof PackageControls>;

export const SkillControls = PackageControls.extend({
  // Agent slugs of the pinned skills CLI (`claude-code`, `codex`, ...).
  agents: nonEmptyList.default(DEFAULT_AGENTS),
});
export type SkillControls = z.infer<typeof SkillControls>;

// Other metadata keys (`requires`, ...) stay free-form: z.object strips them.
export const SkillFrontmatter = z.object({
  name: z.string().min(1),
  metadata: SkillControls.prefault({}),
});

// The Machine a Ship is running on.
export interface MachineContext {
  name: string;
  platform: Platform;
  // True on the Machine that started the Ship (or ran ship:machine directly).
  starting: boolean;
}

export function shipsTo(controls: PackageControls, machine: MachineContext): boolean {
  return (
    controls.platforms.includes(machine.platform) &&
    (controls.machines?.includes(machine.name) ?? true) &&
    (controls.fleet || machine.starting)
  );
}

// Agents a skill installs for on this Machine; empty when it does not ship here.
export function skillAgents(controls: SkillControls, machine: MachineContext): string[] {
  return shipsTo(controls, machine) ? [...new Set(controls.agents)].sort() : [];
}
