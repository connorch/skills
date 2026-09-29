// One `claude-<label>` command per account: Claude Code through the router,
// served only by that account, no failover. The header travels in the
// process environment rather than in `--settings`, because Claude Code keeps
// only the last `--settings` flag and clients such as t3code pass their own.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN_DIR = join(homedir(), ".local", "bin");

export const wrapperName = (label: string) => `claude-${label}`;

export function wrapperScript(label: string): string {
  return `#!/bin/sh
# ${wrapperName(label)} - Claude Code through claude-router, served only by the
# "${label}" account, limit errors included. Written by a Ship; edit
# apps/claude-router/src/wrappers.ts instead.
ANTHROPIC_CUSTOM_HEADERS="x-claude-router-account: ${label}" exec claude "$@"
`;
}

// Writes every wrapper and returns their paths.
export function installWrappers(labels: readonly string[], dir = BIN_DIR): string[] {
  mkdirSync(dir, { recursive: true });
  return labels.map((label) => {
    const path = join(dir, wrapperName(label));
    writeFileSync(path, wrapperScript(label), { mode: 0o755 });
    return path;
  });
}
