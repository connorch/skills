import { createRequire } from "node:module";
import { mkdtemp, realpath, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  exists,
  fingerprint,
  installerEnv,
  run,
  slug,
  type Placement,
} from "./files.ts";

const require = createRequire(import.meta.url);
export const cli = require.resolve("skills/bin/cli.mjs");
export const cliVersion = z
  .object({ version: z.string() })
  .parse(require("skills/package.json")).version;
const frontmatter = z.object({
  name: slug,
  description: z.string().min(1),
  metadata: z
    .object({ "install-agents": z.string().optional() })
    .passthrough()
    .optional(),
});
export type Skill = Awaited<ReturnType<typeof readSkills>>[number];
export async function readSkills(checkout: string) {
  const skills = [];
  for (const entry of (
    await readdir(join(checkout, "skills"), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const source = join(checkout, "skills", entry.name);
    if (!(await exists(join(source, "SKILL.md")))) continue;
    const text = await readFile(join(source, "SKILL.md"), "utf8");
    const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!header) throw new Error(`${entry.name}: missing frontmatter`);
    const data = frontmatter.parse(parse(header));
    if (data.name !== entry.name)
      throw new Error(`${entry.name}: name must match directory`);
    const agents = [
      ...new Set(
        (data.metadata?.["install-agents"] ?? "claude-code,codex")
          .split(",")
          .map((s) => s.trim()),
      ),
    ].sort();
    if (agents.some((agent) => !slug.safeParse(agent).success))
      throw new Error(`${entry.name}: invalid install-agents value`);
    skills.push({ name: data.name, source, agents });
  }
  return skills;
}

export function install(skill: Skill, home: string) {
  const output = run(
    process.execPath,
    [
      cli,
      "add",
      skill.source,
      "-g",
      "-a",
      ...skill.agents,
      "-s",
      skill.name,
      "-y",
    ],
    { cwd: home, env: installerEnv(home) },
  );
  // This release can report an installation error and still exit zero.
  if (
    /Failed to install|does not support global|No skills found|No matching skills/i.test(
      output,
    )
  )
    throw new Error(output.trim());
  return output;
}

async function placements(home: string, name: string): Promise<Placement[]> {
  const found: Placement[] = [];
  async function walk(path: string) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name);
      if (
        item.isSymbolicLink() ||
        (item.isDirectory() && (await exists(join(full, "SKILL.md"))))
      ) {
        const digest = await fingerprint(full);
        if (digest)
          found.push({
            name,
            path: relative(home, full),
            fingerprint: digest,
            adoptionFingerprint: (await fingerprint(full, true)) ?? undefined,
          });
      } else if (item.isDirectory()) await walk(full);
    }
  }
  await walk(home);
  return found;
}

// A real install in an empty home validates upstream slugs and derives placement.
// No duplicate agent registry or private upstream API is needed.
export async function preview(skills: Skill[]): Promise<Placement[]> {
  const result: Placement[] = [];
  for (const skill of skills) {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "skills-fleet-preview-")),
    );
    try {
      install(skill, home);
      const installed = await placements(home, skill.name);
      if (!installed.length)
        throw new Error(`${skill.name}: CLI produced no installation`);
      result.push(...installed);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
  return result;
}

// The CLI list output is used only to find additional legacy copies, never as proof of ownership.
export function installedSkills(home: string) {
  return z.array(z.object({ name: z.string(), path: z.string() })).parse(
    JSON.parse(
      run(process.execPath, [cli, "list", "-g", "--json"], {
        cwd: home,
        env: installerEnv(home),
      }),
    ),
  );
}
