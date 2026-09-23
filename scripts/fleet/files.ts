import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { parse, stringify } from "yaml";

export const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
export const configSchema = z.object({
  machine: slug,
  node: z.string(),
  pnpm: z.string(),
});
export type Config = z.infer<typeof configSchema>;
export const placementSchema = z.object({
  name: slug,
  path: z.string(),
  fingerprint: z.string(),
  adoptionFingerprint: z.string().optional(),
});
export type Placement = z.infer<typeof placementSchema>;
export const attemptSchema = z.object({
  id: z.string(),
  commit: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outcome: z.enum(["running", "success", "failed", "partial"]),
  error: z.string().nullable(),
  logKey: z.string(),
  cliVersion: z.string(),
});
export const stateSchema = z.object({
  installed: z.object({ commit: z.string(), at: z.string() }).nullable(),
  managed: z.array(placementSchema),
  pending: z.array(placementSchema),
  attempt: attemptSchema.nullable(),
});
export type State = z.infer<typeof stateSchema>;
export const emptyState = (): State => ({
  installed: null,
  managed: [],
  pending: [],
  attempt: null,
});

export async function exists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
export async function json<T>(
  path: string,
  schema: z.ZodType<T>,
  fallback?: T,
): Promise<T> {
  if (!(await exists(path)) && fallback !== undefined) return fallback;
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}
export async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}

// Never traverse a symlinked parent when checking or changing an owned placement.
export async function safePath(home: string, path: string) {
  if (
    isAbsolute(path) ||
    !path ||
    path.split(/[\\/]/).some((part) => part === ".." || !part)
  ) {
    throw new Error(`Unsafe installation path: ${path}`);
  }
  const absolute = resolve(home, path);
  if (!absolute.startsWith(resolve(home) + sep))
    throw new Error(`Path escapes home: ${path}`);
  let parent = dirname(absolute);
  while (parent !== resolve(home)) {
    if ((await exists(parent))?.isSymbolicLink())
      throw new Error(`Symlinked installation parent: ${parent}`);
    parent = dirname(parent);
  }
  return absolute;
}

// Hash the files the CLI actually installs, rather than guessing its exclusions.
export async function fingerprint(
  path: string,
  ignoreTargets = false,
): Promise<string | null> {
  const stat = await exists(path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return `link:${await readlink(path)}`;
  const hash = createHash("sha256");
  async function visit(current: string) {
    const item = await lstat(current);
    hash.update(relative(path, current));
    if (item.isSymbolicLink()) hash.update(`link:${await readlink(current)}`);
    else if (item.isDirectory()) {
      for (const name of (await readdir(current)).sort())
        await visit(join(current, name));
    } else if (item.isFile()) {
      hash.update(`file:${item.mode & 0o111}:`);
      let content = await readFile(current);
      if (ignoreTargets && current.endsWith("/SKILL.md")) {
        const text = content.toString("utf8");
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (match) {
          const data = z.record(z.string(), z.unknown()).parse(parse(match[1]));
          if (
            data.metadata &&
            typeof data.metadata === "object" &&
            !Array.isArray(data.metadata)
          ) {
            const metadata = z
              .record(z.string(), z.unknown())
              .parse(data.metadata);
            delete metadata["install-agents"];
            if (Object.keys(metadata).length) data.metadata = metadata;
            else delete data.metadata;
          }
          content = Buffer.from(stringify(data) + text.slice(match[0].length));
        }
      }
      hash.update(content);
    } else throw new Error(`Unsupported file: ${current}`);
  }
  await visit(path);
  return hash.digest("hex");
}

export function run(
  bin: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
) {
  const result = spawnSync(bin, args, {
    ...options,
    timeout: options.timeout ?? 120_000,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(
    /\x1b\[[0-?]*[ -/]*[@-~]/g,
    "",
  );
  if (result.error || result.status !== 0)
    throw new Error(`${bin} failed: ${result.error?.message ?? output.trim()}`);
  return output;
}

// Use the same standard user directories in preflight and the real installation.
// Credentials and harness-specific environment overrides do not enter the installer.
export function installerEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CI: "1",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  };
}
