import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PROFILES, STUDIO_CLI } from "../studio.ts";
import { profileFileSystem, text } from "./profiles.ts";
import { z } from "zod";
export const discoveryFileSystem = {
  ...profileFileSystem,
  isFile: (path: string) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isDirectory: (path: string) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};
export interface DiscoveryOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  fs?: typeof discoveryFileSystem;
}
export function cliCandidates(home = homedir()): string[][] {
  return [[STUDIO_CLI], [join(home, "Applications/BambuStudio.app/Contents/MacOS/BambuStudio")]];
}
export function profileCandidates(home = homedir(), cli?: string[]): string[] {
  return [
    ...(cli?.length === 1 && cli[0]
      ? [join(dirname(dirname(resolve(cli[0]))), "Resources/profiles")]
      : []),
    dirname(PROFILES),
    join(home, "Applications/BambuStudio.app/Contents/Resources/profiles"),
    join(home, "Library/Application Support/BambuStudio/system"),
  ];
}
export function findCli({
  home = homedir(),
  env = process.env,
  fs = discoveryFileSystem,
}: DiscoveryOptions = {}): string[] | undefined {
  const override = env.BAMBU_STUDIO_CLI;
  if (override) return fs.isFile(override) ? [override] : undefined;
  return cliCandidates(home).find((command) => Boolean(command[0] && fs.isFile(command[0])));
}
export function bundleVersion(root: string, fs = discoveryFileSystem): number[] {
  try {
    const doc = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(fs.read(join(root, "BBL.json"))));
    return text(doc, "version")
      .split(".")
      .filter((p) => /^\d+$/.test(p))
      .map(Number);
  } catch {
    return [];
  }
}
export function isProfileBundle(root: string, fs = discoveryFileSystem): boolean {
  return fs.isFile(join(root, "BBL.json")) && fs.isDirectory(join(root, "BBL"));
}
// Prefer the newest bundle; ties retain the copy beside the Studio CLI.
export function findProfilesDir(
  cli?: string[],
  { home = homedir(), env = process.env, fs = discoveryFileSystem }: DiscoveryOptions = {},
): string | undefined {
  const override = env.BAMBU_STUDIO_PROFILES;
  if (override) return isProfileBundle(override, fs) ? override : undefined;
  let best: string | undefined;
  let version: number[] = [];
  let resolvedCli = cli;
  if (cli?.length === 1 && cli[0]) {
    try {
      resolvedCli = [fs.realpath(cli[0])];
    } catch {
      /* Missing candidates are checked below. */
    }
  }
  for (const root of profileCandidates(home, resolvedCli)) {
    if (!isProfileBundle(root, fs)) continue;
    const candidate = bundleVersion(root, fs);
    let comparison = 0;
    for (let i = 0; i < Math.max(candidate.length, version.length); i++) {
      comparison = (candidate[i] ?? -1) - (version[i] ?? -1);
      if (comparison) break;
    }
    if (best === undefined || comparison > 0) {
      best = root;
      version = candidate;
    }
  }
  return best;
}
