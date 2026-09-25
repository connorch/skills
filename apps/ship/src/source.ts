// Reads what a source tree (a working copy or a Managed Clone) wants to ship:
// its Live Skills and the workspace packages that define a ship:machine script.

import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PackageControls, SkillFrontmatter, type SkillControls } from "./controls.ts";

export interface LiveSkill {
  name: string;
  controls: SkillControls;
}

export interface ShipPackage {
  name: string;
  dir: string;
  controls: PackageControls;
}

// Every problem found in a source tree, reported together before any change.
export class ValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid source tree:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.issues = issues;
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export interface Source {
  skills: LiveSkill[];
  packages: ShipPackage[];
}

// Throws a ValidationError listing every invalid skill and package.
export function readSource(root: string): Source {
  const issues: string[] = [];
  const source = { skills: readLiveSkills(root, issues), packages: readShipPackages(root, issues) };
  if (issues.length > 0) throw new ValidationError(issues);
  return source;
}

function readLiveSkills(root: string, issues: string[]): LiveSkill[] {
  const skillsDir = join(root, "skills");
  const skills: LiveSkill[] = [];

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(skillFile)) continue;

    const frontmatter = FRONTMATTER.exec(readFileSync(skillFile, "utf8"))?.[1];
    if (frontmatter === undefined) {
      issues.push(`skills/${entry.name}: SKILL.md has no frontmatter`);
      continue;
    }
    const parsed = SkillFrontmatter.safeParse(parseYaml(frontmatter));
    if (!parsed.success) {
      issues.push(`skills/${entry.name}: ${describe(parsed.error)}`);
    } else if (parsed.data.name !== entry.name) {
      issues.push(`skills/${entry.name}: name "${parsed.data.name}" does not match its directory`);
    } else {
      skills.push({ name: entry.name, controls: parsed.data.metadata });
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

const WorkspaceFile = z.object({ packages: z.array(z.string()).default([]) });

const PackageJson = z.object({
  name: z.string().min(1),
  scripts: z.record(z.string(), z.string()).default({}),
  ship: PackageControls.prefault({}),
});

function readShipPackages(root: string, issues: string[]): ShipPackage[] {
  const workspace = WorkspaceFile.parse(
    parseYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")),
  );
  const packages: ShipPackage[] = [];

  for (const manifest of globSync(
    workspace.packages.map((pattern) => `${pattern}/package.json`),
    { cwd: root },
  )) {
    const parsed = PackageJson.safeParse(JSON.parse(readFileSync(join(root, manifest), "utf8")));
    if (!parsed.success) {
      issues.push(`${manifest}: ${describe(parsed.error)}`);
    } else if (parsed.data.scripts["ship:machine"] !== undefined) {
      packages.push({
        name: parsed.data.name,
        dir: join(root, dirname(manifest)),
        controls: parsed.data.ship,
      });
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}
