import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { z } from "zod";

export type Profile = Record<string, unknown>;
export type Kind = "machine_model" | "machine" | "process" | "filament";
export const KINDS: Kind[] = ["machine_model", "machine", "process", "filament"];
export class ProfileError extends Error {}
export const profileFileSystem = {
  read: (path: string) => readFileSync(path, "utf8"),
  realpath: (path: string) => realpathSync(path),
};
export function text(profile: Profile, key: string): string {
  const value = profile[key];
  return typeof value === "string"
    ? value
    : Array.isArray(value) && typeof value[0] === "string"
      ? value[0]
      : "";
}
export function strings(profile: Profile, key: string): string[] {
  const value = profile[key];
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
}
export function number(profile: Profile, key: string): number | undefined {
  const value = text(profile, key).trim();
  return value && Number.isFinite(Number(value)) ? Number(value) : undefined;
}
const identity = new Set(["name", "setting_id", "instantiation", "from", "type"]);
const links = new Set(["inherits", "include"]);
const excludedIncludes = new Set([...identity, ...links, "filament_id"]);

// Resolve the vendor index, parent chains and G-code includes before passing presets to Studio.
export class ProfileLibrary {
  readonly version: string;
  private readonly paths = new Map<Kind, Map<string, string>>();
  private readonly raws = new Map<string, Profile>();
  private readonly flats = new Map<string, Profile>();
  constructor(
    readonly root: string,
    private readonly fs = profileFileSystem,
  ) {
    const index = this.read(join(root, "BBL.json"));
    this.version = text(index, "version");
    for (const kind of KINDS) {
      const entries = z.array(z.unknown()).catch([]).parse(index[`${kind}_list`]);
      const paths = new Map<string, string>();
      for (const entry of entries) {
        const parsed = z.object({ name: z.string(), sub_path: z.string() }).safeParse(entry);
        if (parsed.success) paths.set(parsed.data.name, resolve(root, "BBL", parsed.data.sub_path));
      }
      this.paths.set(kind, paths);
    }
  }
  private read(path: string): Profile {
    try {
      return z.record(z.string(), z.unknown()).parse(JSON.parse(this.fs.read(path)));
    } catch (error) {
      throw new ProfileError(`cannot read profile file ${path}: ${String(error)}`);
    }
  }
  names(kind: Kind): string[] {
    return [...(this.paths.get(kind)?.keys() ?? [])].sort();
  }
  has(kind: Kind, name: string): boolean {
    return this.paths.get(kind)?.has(name) ?? false;
  }
  raw(kind: Kind, name: string): Profile {
    const key = `${kind}:${name}`;
    const cached = this.raws.get(key);
    if (cached) return cached;
    const path = this.paths.get(kind)?.get(name);
    if (!path) throw new ProfileError(`no ${kind} profile named '${name}' in ${this.root}`);
    let rel: string;
    try {
      rel = relative(this.fs.realpath(join(this.root, "BBL")), this.fs.realpath(path));
    } catch (error) {
      throw new ProfileError(`cannot read profile file ${path}: ${String(error)}`);
    }
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new ProfileError(`${kind} profile '${name}' points outside ${join(this.root, "BBL")}`);
    const result = this.read(path);
    this.raws.set(key, result);
    return result;
  }
  flatten(kind: Kind, name: string, chain: string[] = []): Profile {
    const key = `${kind}:${name}`;
    const cached = this.flats.get(key);
    if (cached) return { ...cached };
    if (chain.includes(name))
      throw new ProfileError(`${kind} profile inheritance loops: ${[...chain, name].join(" -> ")}`);
    const own = this.raw(kind, name);
    const next = [...chain, name];
    const parent = text(own, "inherits");
    const merged: Profile = {};
    if (parent)
      for (const [key, value] of Object.entries(this.flatten(kind, parent, next)))
        if (!identity.has(key)) merged[key] = value;
    for (const include of strings(own, "include"))
      for (const [key, value] of Object.entries(this.flatten(kind, include, next)))
        if (!excludedIncludes.has(key)) merged[key] = value;
    for (const [key, value] of Object.entries(own)) if (!links.has(key)) merged[key] = value;
    this.flats.set(key, merged);
    return { ...merged };
  }
  instances(kind: Kind): Candidate[] {
    return this.names(kind)
      .filter((name) => text(this.raw(kind, name), "instantiation") === "true")
      .map((name) => [name, this.flatten(kind, name)]);
  }
}
export type Candidate = [name: string, profile: Profile];
