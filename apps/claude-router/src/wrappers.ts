// One `claude-<label>` command per account: Claude Code through the router,
// served only by that account, no failover. The header travels in the
// process environment rather than in `--settings`, because Claude Code keeps
// only the last `--settings` flag and clients such as t3code pass their own.

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN_DIR = join(homedir(), ".local", "bin");

export const wrapperName = (label: string) => `claude-${label}`;
// The first two lines of every wrapper. A stale wrapper is recognized by
// them alone, so nothing else that happens to mention the marker (the
// router's own bundle does) is ever touched.
const header = (name: string) =>
  `#!/bin/sh\n# ${name} - Claude Code through claude-router, served only by the`;

export function wrapperScript(label: string): string {
  return `${header(wrapperName(label))}
# "${label}" account, limit errors included. Written by a Ship; edit
# apps/claude-router/src/wrappers.ts instead.
ANTHROPIC_CUSTOM_HEADERS="x-claude-router-account: ${label}" exec claude "$@"
`;
}

// Writes every wrapper, removes ones this installer wrote for labels that are
// gone, and returns the paths written.
export function installWrappers(labels: readonly string[], dir = BIN_DIR): string[] {
  mkdirSync(dir, { recursive: true });
  const wanted = new Set(labels.map(wrapperName));
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("claude-") || wanted.has(name)) continue;
    const path = join(dir, name);
    try {
      if (readFileSync(path, "utf8").startsWith(header(name))) unlinkSync(path);
    } catch {
      // Not a readable file: not ours.
    }
  }
  return labels.map((label) => {
    const path = join(dir, wrapperName(label));
    writeFileSync(path, wrapperScript(label), { mode: 0o755 });
    return path;
  });
}
