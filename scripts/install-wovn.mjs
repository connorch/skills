#!/usr/bin/env node
// Builds the wovn CLI and copies the bundle to ~/.local/bin/wovn. The copy is
// self-contained, so it keeps working after the worktree it came from is gone.

import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(repoRoot, "apps", "wovn-cli", "dist", "wovn.mjs");
const target = process.env.WOVN_INSTALL_PATH ?? join(homedir(), ".local", "bin", "wovn");

const build = spawnSync("pnpm", ["--filter", "wovn-cli", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(dirname(target), { recursive: true });
copyFileSync(bundle, target);
chmodSync(target, 0o755);
console.log(`installed ${target}`);
