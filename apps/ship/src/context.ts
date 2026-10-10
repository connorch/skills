// The Machine the installer runs on, plus every Machine name on the tailnet
// (to validate `machines` controls). fleetfizz sets FLEETFIZZ_MACHINE,
// FLEETFIZZ_PLATFORM, and FLEETFIZZ_MACHINES for every Install Command; run by
// hand, the same facts come from `tailscale status --json`.

import { execFileSync } from "node:child_process";
import { z } from "zod";
import { Platform, type MachineContext } from "./controls.ts";

export interface InstallContext {
  machine: MachineContext;
  knownMachines: string[];
}

const FleetfizzEnv = z.object({
  FLEETFIZZ_MACHINE: z.string().min(1),
  FLEETFIZZ_PLATFORM: Platform,
  FLEETFIZZ_MACHINES: z.string().min(1),
});

// The context fleetfizz passed in, or undefined when none of its variables are
// set. Setting only some of them is a mistake, so it throws.
export function contextFromEnv(env: NodeJS.ProcessEnv): InstallContext | undefined {
  const present = Object.keys(FleetfizzEnv.shape).filter((key) => env[key] !== undefined);
  if (present.length === 0) return undefined;
  const result = FleetfizzEnv.safeParse(env);
  if (!result.success) {
    const keys = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`fleetfizz context is incomplete or invalid: ${keys}`);
  }
  const parsed = result.data;
  return {
    machine: { name: parsed.FLEETFIZZ_MACHINE, platform: parsed.FLEETFIZZ_PLATFORM },
    knownMachines: parsed.FLEETFIZZ_MACHINES.split(",").filter(Boolean),
  };
}

const Node = z.object({ DNSName: z.string(), OS: z.string() });
const TailscaleStatus = z.object({ Self: Node, Peer: z.record(z.string(), Node).nullish() });

const PLATFORM_BY_OS: Partial<Record<string, Platform>> = { macOS: "darwin", linux: "linux" };

// Machines are named by the first label of their MagicDNS name, which stays
// stable when the OS hostname does not. Only macOS and linux nodes count.
function toMachine(node: z.infer<typeof Node>): MachineContext | undefined {
  const platform = PLATFORM_BY_OS[node.OS];
  const name = node.DNSName.split(".")[0];
  return platform && name ? { name, platform } : undefined;
}

export function contextFromTailscale(status: unknown): InstallContext {
  const parsed = TailscaleStatus.parse(status);
  const machine = toMachine(parsed.Self);
  if (!machine) throw new Error(`this Machine's OS (${parsed.Self.OS}) cannot ship`);
  const peers = Object.values(parsed.Peer ?? {}).flatMap((node) => toMachine(node) ?? []);
  return {
    machine,
    knownMachines: [machine, ...peers].map(({ name }) => name).sort(),
  };
}

export function readContext(): InstallContext {
  return (
    contextFromEnv(process.env) ??
    contextFromTailscale(
      JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" })),
    )
  );
}
