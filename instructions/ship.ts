// ship:machine for the global agent instructions. AGENTS.md is shared by every
// harness; each harness loads one file: AGENTS.md with its *_ONLY.md appended.
// With --dry-run, writes them under instructions/dry-run/ (gitignored) instead
// of the home directory, for review.

import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

// Target path under the home directory -> source files, joined in order.
const TARGETS = {
  ".agents/AGENTS.md": ["AGENTS.md"],
  ".claude/CLAUDE.md": ["AGENTS.md", "CLAUDE_ONLY.md"],
  ".codex/AGENTS.md": ["AGENTS.md", "CODEX_ONLY.md"],
};

const DRY_RUN_DIR = join(import.meta.dirname, "dry-run");

const { dryRun } = new Command("ship:machine")
  .description("Write the global agent instructions for every harness on this Machine")
  .option("--dry-run", "write the files to instructions/dry-run/ instead, for review", false)
  .parse()
  .opts<{ dryRun: boolean }>();

// Start each dry run clean, so it holds exactly what a Ship would write.
if (dryRun) rmSync(DRY_RUN_DIR, { recursive: true, force: true });

for (const [target, files] of Object.entries(TARGETS)) {
  const sources = files.map((file) => readFileSync(join(import.meta.dirname, file), "utf8"));
  const header = [
    "<!--",
    "  GENERATED FILE - DO NOT EDIT.",
    `  Built by connorch/skills instructions/ship.ts from: ${files.join(" + ")}`,
    "  Edit those files in that repo and run a Ship. The next Ship overwrites any edits made here.",
    "-->",
  ].join("\n");
  const content = `${header}\n\n${sources.join("\n")}`;
  const home = join(homedir(), target);
  const path = dryRun ? join(DRY_RUN_DIR, target) : home;

  mkdirSync(dirname(path), { recursive: true });
  // Write a temp file and rename it, so no agent ever reads a half-written file.
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);

  if (dryRun) {
    const current = existsSync(home) ? readFileSync(home, "utf8") : undefined;
    const status = current === undefined ? "new" : current === content ? "unchanged" : "changed";
    console.log(`~/${target} (${status}): ${relative(join(import.meta.dirname, ".."), path)}`);
  }
}
