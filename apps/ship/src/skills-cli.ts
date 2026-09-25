// The pinned skills CLI (the `skills` catalog entry), always run globally and
// non-interactively. Its box-drawn output is captured and shown only when a
// command fails.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const BIN = fileURLToPath(new URL("../node_modules/.bin/skills", import.meta.url));

export interface CliResult {
  ok: boolean;
  output: string;
}

function run(args: string[]): CliResult {
  const result = spawnSync(BIN, args, {
    encoding: "utf8",
    env: { ...process.env, DO_NOT_TRACK: "1", NO_COLOR: "1" },
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`,
  };
}

export function addSkills(sourceRoot: string, skills: string[], agents: string[]): CliResult {
  return run([
    "add",
    sourceRoot,
    "--global",
    ...agents.flatMap((agent) => ["--agent", agent]),
    "--skill",
    ...skills,
    "--yes",
  ]);
}

// Removes the skills from every agent, including the shared ~/.agents copy.
export function removeSkills(skills: string[]): CliResult {
  return run(["remove", "--global", "--skill", ...skills, "--yes"]);
}

// The CLI has no command that lists its agent slugs, but `add` prints them
// when it rejects one, before it changes anything. `probeSkill` must exist in
// `sourceRoot` so the command gets as far as checking agents.
export function supportedAgents(sourceRoot: string, probeSkill: string): string[] {
  const { output } = run([
    "add",
    sourceRoot,
    "--global",
    "--agent",
    "ship-probe",
    "--skill",
    probeSkill,
    "--yes",
  ]);
  const list = /Valid agents: ([a-z0-9, -]+)/.exec(output)?.[1];
  if (list === undefined) throw new Error(`could not read the skills CLI's agent list:\n${output}`);
  return list.split(",").map((agent) => agent.trim());
}

const Lock = z.object({
  skills: z.record(z.string(), z.object({ source: z.string() })).default({}),
});

// Lock sources by skill name. The CLI records only remote installs here.
export function readLockSources(): Map<string, string> {
  const stateHome = process.env.XDG_STATE_HOME;
  const lockPath = stateHome
    ? join(stateHome, "skills", ".skill-lock.json")
    : join(homedir(), ".agents", ".skill-lock.json");
  if (!existsSync(lockPath)) return new Map();
  const lock = Lock.parse(JSON.parse(readFileSync(lockPath, "utf8")));
  return new Map(Object.entries(lock.skills).map(([name, entry]) => [name, entry.source]));
}
