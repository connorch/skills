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
const claudeSkills = skillNames.filter((name) => name.startsWith("claude-"));
const sharedSkills = skillNames.filter(
  (name) => !name.startsWith("codex-") && !name.startsWith("claude-"),
);
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

if (claudeSkills.length > 0) {
  // Removing the Claude Code install also deletes the shared ~/.agents copy that
  // Codex reads, so it has to run before the Codex install, not after.
  commands.push({
    bin: "skills",
    args: ["remove", "-g", "-a", "claude-code", "-s", ...claudeSkills, "-y"],
    display: `skills remove -g -a claude-code -s ${claudeSkills.join(" ")} -y`,
  });

  commands.push({
    bin: "skills",
    args: ["add", repoRoot, "-g", "-a", "codex", "-s", ...claudeSkills, "-y"],
    display: `skills add ${repoRoot} -g -a codex -s ${claudeSkills.join(" ")} -y`,
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
