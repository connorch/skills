// The Fleet, as `tailscale status --json` reports it: this Machine plus every
// macOS and linux peer. Machines are named by the first label of their
// MagicDNS name (connors-mac-studio), which stays stable when the OS hostname
// does not.

import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { Platform } from "./controls.ts";

const Node = z.object({
  DNSName: z.string(),
  OS: z.string(),
  Online: z.boolean().optional(),
  sshHostKeys: z.array(z.string()).nullish(),
});
type Node = z.infer<typeof Node>;

const TailscaleStatus = z.object({
  Self: Node,
  Peer: z.record(z.string(), Node).nullish(),
});

export interface Machine {
  name: string;
  platform: Platform;
  online: boolean;
  // Runs a Tailscale SSH server (always false for this Machine's own entry).
  ssh: boolean;
}

export interface Tailnet {
  self: Machine;
  // Every macOS and linux Machine, this one included, sorted by name.
  fleet: Machine[];
}

const PLATFORM_BY_OS: Record<string, Platform> = { macOS: "darwin", linux: "linux" };

function toMachine(node: Node): Machine | undefined {
  const platform = PLATFORM_BY_OS[node.OS];
  const name = node.DNSName.split(".")[0];
  if (platform === undefined || !name) return undefined;
  return { name, platform, online: node.Online ?? false, ssh: (node.sshHostKeys?.length ?? 0) > 0 };
}

export function parseTailnet(status: unknown): Tailnet {
  const parsed = TailscaleStatus.parse(status);
  const self = toMachine(parsed.Self);
  if (self === undefined) throw new Error(`this Machine's OS (${parsed.Self.OS}) cannot ship`);
  const peers = Object.values(parsed.Peer ?? {}).flatMap((node) => toMachine(node) ?? []);
  return {
    self: { ...self, online: true },
    fleet: [{ ...self, online: true }, ...peers].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function readTailnet(): Tailnet {
  return parseTailnet(
    JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" })),
  );
}
