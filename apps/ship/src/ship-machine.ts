// One machine Ship: bring this Machine's skills and packages in line with a
// source tree. Validation covers the whole tree before anything changes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { shipsTo, skillAgents, type MachineContext } from "./controls.ts";
import { EMPTY_MANIFEST, Manifest, nextManifest, planSkills } from "./plan.ts";
import type { MachineReport } from "./report.ts";
import { addSkills, readLockSources, removeSkills, supportedAgents } from "./skills-cli.ts";
import { readSource, ValidationError } from "./source.ts";

export interface ShipMachineOptions {
  root: string;
  // `owner/repo`, matched against skills CLI lock sources.
  slug: string;
  manifestPath: string;
  machine: MachineContext;
  // Every Machine name on the tailnet, for validating `machines` controls.
  knownMachines: string[];
  source: string;
  dryRun: boolean;
  log: (line: string) => void;
}

function readManifest(path: string): Manifest {
  return existsSync(path) ? Manifest.parse(JSON.parse(readFileSync(path, "utf8"))) : EMPTY_MANIFEST;
}

function checkNames(root: string, knownMachines: string[]) {
  const source = readSource(root);
  const issues: string[] = [];
  const agents = source.skills[0] ? supportedAgents(root, source.skills[0].name) : [];
  for (const skill of source.skills) {
    for (const agent of skill.controls.agents.filter((agent) => !agents.includes(agent))) {
      issues.push(
        `skills/${skill.name}: unknown agent "${agent}" (the skills CLI supports: ${agents.join(", ")})`,
      );
    }
  }
  const targeted = [
    ...source.skills.map((skill) => ({
      label: `skills/${skill.name}`,
      machines: skill.controls.machines,
    })),
    ...source.packages.map((pkg) => ({ label: pkg.name, machines: pkg.controls.machines })),
  ];
  for (const { label, machines } of targeted) {
    for (const machine of machines?.filter((name) => !knownMachines.includes(name)) ?? []) {
      issues.push(
        `${label}: unknown Machine "${machine}" (the tailnet has: ${knownMachines.join(", ")})`,
      );
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return source;
}

export function shipMachine(options: ShipMachineOptions): MachineReport {
  const { root, machine, dryRun, log } = options;
  const source = checkNames(root, options.knownMachines);

  const desired = new Map(
    source.skills
      .map((skill) => [skill.name, skillAgents(skill.controls, machine)] as const)
      .filter(([, agents]) => agents.length > 0),
  );
  const manifest = readManifest(options.manifestPath);
  const plan = planSkills({
    desired,
    manifest,
    lockSources: readLockSources(),
    ownSource: options.slug,
  });
  const packages = source.packages.filter((pkg) => shipsTo(pkg.controls, machine));
  const shipping = [...desired.keys()].filter((name) => !plan.conflicts.includes(name));

  const failures = plan.conflicts.map(
    (name) => `${name}: installed from another source; remove it or rename this skill`,
  );
  const report: MachineReport = {
    source: options.source,
    skills: shipping.length,
    added: shipping.filter((name) => !(name in manifest.skills)),
    removed: Object.keys(manifest.skills).filter(
      (name) => !desired.has(name) && !plan.forget.includes(name),
    ),
    packages: packages.map((pkg) => pkg.name),
    failures,
    dryRun,
  };

  const reinstall = plan.remove.filter((name) => shipping.includes(name));
  const remove = plan.remove.filter((name) => !shipping.includes(name));
  if (remove.length > 0) log(`remove: ${remove.join(", ")}`);
  if (reinstall.length > 0) log(`remove, then reinstall: ${reinstall.join(", ")}`);
  for (const group of plan.install)
    log(`install for ${group.agents.join(", ")}: ${group.skills.join(", ")}`);
  for (const failure of failures) log(`conflict: ${failure}`);
  for (const pkg of packages) log(`package: ${pkg.name}`);
  if (dryRun) return report;

  let removed = true;
  if (plan.remove.length > 0) {
    const result = removeSkills(plan.remove);
    removed = result.ok;
    if (!result.ok) failures.push(`remove ${plan.remove.join(", ")} failed:\n${result.output}`);
  }
  for (const group of plan.install) {
    const result = addSkills(root, group.skills, group.agents);
    if (!result.ok)
      failures.push(`install for ${group.agents.join(", ")} failed:\n${result.output}`);
  }
  mkdirSync(dirname(options.manifestPath), { recursive: true });
  writeFileSync(
    options.manifestPath,
    `${JSON.stringify(nextManifest(manifest, plan, removed), null, 2)}\n`,
  );

  for (const pkg of packages) {
    log(`running ship:machine in ${pkg.name}`);
    const result = spawnSync("pnpm", ["run", "--silent", "ship:machine"], {
      cwd: pkg.dir,
      stdio: "inherit",
    });
    if (result.status !== 0)
      failures.push(`${pkg.name}: ship:machine exited ${result.status ?? result.signal}`);
  }
  return report;
}
