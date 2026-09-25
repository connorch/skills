// A machine Ship end to end, against the real pinned skills CLI in a
// throwaway HOME with a synthetic source tree.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { shipMachine, type ShipMachineOptions } from "./ship-machine.ts";
import { ValidationError } from "./source.ts";

const work = mkdtempSync(join(tmpdir(), "ship-test-"));
const home = join(work, "home");
const root = join(work, "repo");
const savedEnv = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME };

function writeSkill(name: string, metadata = "") {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(
    join(root, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}.\n${metadata}---\n# ${name}\n`,
  );
}

function ship(overrides: Partial<ShipMachineOptions> = {}) {
  return shipMachine({
    root,
    slug: "connorch/skills",
    manifestPath: join(home, ".local/state/connorch-skills/manifest.json"),
    machine: { name: "connors-mac-studio", platform: "darwin", starting: false },
    knownMachines: ["connors-mac-studio", "hermes-agent"],
    source: "test",
    dryRun: false,
    log: () => {},
    ...overrides,
  });
}

const claude = (name: string) => join(home, ".claude/skills", name);
const shared = (name: string) => join(home, ".agents/skills", name);

beforeAll(() => {
  mkdirSync(home);
  process.env.HOME = home;
  delete process.env.XDG_STATE_HOME;
  mkdirSync(join(root, "pkgs/tool"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - pkgs/*\n");
  writeFileSync(
    join(root, "pkgs/tool/package.json"),
    JSON.stringify({ name: "tool", scripts: { "ship:machine": 'touch "$HOME/tool-shipped"' } }),
  );
  writeSkill("alpha", "metadata:\n  agents: [claude-code]\n");
  writeSkill("beta");
  writeSkill("gamma", "metadata:\n  agents: [codex]\n");
  writeSkill("delta", "metadata:\n  machines: [hermes-agent]\n");
});

afterAll(() => {
  Object.assign(process.env, savedEnv);
  rmSync(work, { recursive: true, force: true });
});

describe("shipMachine", () => {
  it("installs each skill for its agents and runs package scripts", () => {
    const report = ship();
    expect(report.failures).toEqual([]);
    expect(report.added).toEqual(["alpha", "beta", "gamma"]);
    expect(lstatSync(claude("alpha")).isDirectory()).toBe(true);
    expect(existsSync(shared("alpha"))).toBe(false);
    expect(existsSync(join(claude("beta"), "SKILL.md"))).toBe(true);
    expect(existsSync(join(shared("beta"), "SKILL.md"))).toBe(true);
    expect(existsSync(shared("gamma"))).toBe(true);
    expect(existsSync(claude("gamma"))).toBe(false);
    expect(existsSync(claude("delta")) || existsSync(shared("delta"))).toBe(false);
    expect(existsSync(join(home, "tool-shipped"))).toBe(true);
  });

  it("removes deleted skills and the placements a skill no longer targets", () => {
    writeSkill("beta", "metadata:\n  agents: [claude-code]\n");
    rmSync(join(root, "skills/gamma"), { recursive: true });

    const report = ship();
    expect(report.failures).toEqual([]);
    expect(report.removed).toEqual(["gamma"]);
    expect(existsSync(shared("gamma"))).toBe(false);
    expect(existsSync(shared("beta"))).toBe(false);
    expect(existsSync(join(claude("beta"), "SKILL.md"))).toBe(true);
  });

  it("leaves a name installed from another source alone and reports the conflict", () => {
    writeFileSync(
      join(home, ".agents/.skill-lock.json"),
      JSON.stringify({ version: 3, skills: { alpha: { source: "someone/else" } } }),
    );
    const report = ship();
    expect(report.failures).toEqual([
      "alpha: installed from another source; remove it or rename this skill",
    ]);
    expect(existsSync(claude("alpha"))).toBe(true);
    rmSync(join(home, ".agents/.skill-lock.json"));
  });

  it("rejects unknown agents and Machines before changing anything", () => {
    writeSkill("epsilon", "metadata:\n  agents: [claud-code]\n  machines: [studio]\n");
    expect(() => ship()).toThrow(ValidationError);
    expect(() => ship()).toThrow(/unknown agent "claud-code".*\n.*unknown Machine "studio"/);
    expect(existsSync(claude("epsilon")) || existsSync(shared("epsilon"))).toBe(false);
    rmSync(join(root, "skills/epsilon"), { recursive: true });
  });
});
