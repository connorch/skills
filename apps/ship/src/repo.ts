// This repo's identity and the per-Machine paths derived from it. Everything
// keys off the checkout's `origin` remote, so a fork ships its own repo.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The checkout this code runs from: a working copy or a Managed Clone.
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

// `owner/repo`, the form the skills CLI records as a lock source.
export function repoSlug(): string {
  const origin = git("remote", "get-url", "origin");
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(origin);
  if (!match) throw new Error(`origin is not a GitHub repo: ${origin}`);
  return `${match[1]}/${match[2]}`;
}

export function cloneUrl(slug: string): string {
  return `https://github.com/${slug}.git`;
}

// Kept relative to $HOME so a Ship can hand them to another Machine's shell.
export function managedCloneDir(slug: string): string {
  return `.local/share/${slug.replace("/", "-")}`;
}

export function manifestPath(slug: string): string {
  return join(homedir(), ".local", "state", slug.replace("/", "-"), "manifest.json");
}

// Short commit of this checkout, marked when it has uncommitted changes.
export function describeHead(): string {
  const dirty = git("status", "--porcelain") !== "";
  return `${git("rev-parse", "--short", "HEAD")}${dirty ? "+dirty" : ""}`;
}
