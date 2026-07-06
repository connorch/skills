#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "skills");
const dryRun = process.argv.includes("--dry-run");

const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(skillsRoot, name, "SKILL.md")))
  .sort();

const codexSkills = skillNames.filter((name) => name.startsWith("codex-"));
const sharedSkills = skillNames.filter((name) => !name.startsWith("codex-"));
const universalCodexSkillPaths = codexSkills.map((name) =>
  join(process.env.HOME ?? "~", ".agents", "skills", name),
);

const commands = [];

if (codexSkills.length > 0) {
  commands.push({
    bin: "skills",
    args: ["add", repoRoot, "-g", "-a", "claude-code", "-s", ...codexSkills, "-y"],
    display: `skills add ${repoRoot} -g -a claude-code -s ${codexSkills.join(" ")} -y`,
  });

  commands.push({
    bin: "rm",
    args: ["-rf", ...universalCodexSkillPaths],
    display: `rm -rf ${codexSkills.map((name) => `~/.agents/skills/${name}`).join(" ")}`,
    run: async () => {
      await Promise.all(
        universalCodexSkillPaths.map((path) => rm(path, { force: true, recursive: true })),
      );
    },
  });

  commands.push({
    bin: "skills",
    args: ["remove", "-g", "-a", "codex", "-s", ...codexSkills, "-y"],
    display: `skills remove -g -a codex -s ${codexSkills.join(" ")} -y`,
  });
}

if (sharedSkills.length > 0) {
  commands.push({
    bin: "skills",
    args: ["add", repoRoot, "-g", "-a", "claude-code", "-a", "codex", "-s", ...sharedSkills, "-y"],
    display: `skills add ${repoRoot} -g -a claude-code -a codex -s ${sharedSkills.join(" ")} -y`,
  });
}

if (dryRun) {
  console.log(commands.map((command) => command.display).join("\n"));
  process.exit(0);
}

for (const command of commands) {
  if (command.run) {
    await command.run();
    continue;
  }

  const result = spawnSync(command.bin, command.args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
