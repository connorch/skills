// `pnpm ship:fleet`: a Ship across the Fleet. This Machine ships its working
// copy; every other reachable Machine resets its Managed Clone to origin/main
// over `tailscale ssh` and runs ship:machine there. Machines run in parallel.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describeChanges, parseReport, type MachineReport } from "./report.ts";
import { cloneUrl, managedCloneDir, REPO_ROOT, repoSlug } from "./repo.ts";
import { readTailnet, type Machine } from "./tailnet.ts";

export type Outcome =
  | { kind: "ok"; report: MachineReport }
  | { kind: "failed"; source: string; reason: string }
  | { kind: "skipped"; reason: string };

// `tailscale ssh` exits 255 when it cannot connect or the policy denies the login.
const SSH_FAILURE = 255;

// `errors` is the Machine's non-empty stderr lines.
export function outcomeOf(
  exitCode: number | null,
  report: MachineReport | undefined,
  errors: string[],
): Outcome {
  if (report) {
    return report.failures.length === 0
      ? { kind: "ok", report }
      : { kind: "failed", source: report.source, reason: report.failures[0]?.split("\n")[0] ?? "" };
  }
  // ssh explains a refused login first; a failed script explains itself last.
  if (exitCode === SSH_FAILURE)
    return { kind: "skipped", reason: `ssh: ${errors[0] ?? "connection failed"}` };
  return { kind: "failed", source: "-", reason: errors.at(-1) ?? `exited ${exitCode}` };
}

// The script a remote Machine runs in its login shell. Written for both zsh
// (macOS) and bash (linux).
function remoteScript(slug: string, dryRun: boolean): string {
  const dir = `"$HOME/${managedCloneDir(slug)}"`;
  return [
    "set -e",
    `if [ ! -d ${dir}/.git ]; then git clone --quiet ${cloneUrl(slug)} ${dir}; fi`,
    `cd ${dir}`,
    "git fetch --quiet origin main",
    "git reset --quiet --hard origin/main",
    "git clean --quiet -fd",
    'out=$(pnpm install --frozen-lockfile 2>&1) || { printf "%s\\n" "$out"; exit 1; }',
    `exec pnpm --silent ship:machine --remote --report${dryRun ? " --dry-run" : ""}`,
  ].join("\n");
}

function shipTo(
  machine: Machine,
  self: string,
  slug: string,
  dryRun: boolean,
  width: number,
): Promise<Outcome> {
  if (!machine.online) return Promise.resolve({ kind: "skipped", reason: "offline" });
  const local = machine.name === self;
  if (!local && !machine.ssh)
    return Promise.resolve({ kind: "skipped", reason: "no Tailscale SSH server" });

  const flags = ["--report", ...(dryRun ? ["--dry-run"] : [])];
  const child = local
    ? spawn(process.execPath, [fileURLToPath(new URL("machine.ts", import.meta.url)), ...flags], {
        cwd: REPO_ROOT,
      })
    : spawn("tailscale", ["ssh", machine.name, remoteScript(slug, dryRun)], {
        stdio: ["ignore", "pipe", "pipe"],
      });

  const prefix = `${machine.name.padEnd(width)} | `;
  let report: MachineReport | undefined;
  const errors: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const parsed = parseReport(line);
    if (parsed) report = parsed;
    else console.log(prefix + line);
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    if (line.trim()) errors.push(line.trim());
    console.error(prefix + line);
  });
  return new Promise((resolve) => {
    child.on("error", (error) => resolve({ kind: "failed", source: "-", reason: error.message }));
    child.on("close", (code) => resolve(outcomeOf(code, report, errors)));
  });
}

function summaryTable(rows: { name: string; outcome: Outcome }[]): string {
  const cells = rows.map(({ name, outcome }) => {
    switch (outcome.kind) {
      case "ok":
        return [
          name,
          outcome.report.source,
          `${outcome.report.dryRun ? "dry run" : "ok"}  (${describeChanges(outcome.report)})`,
        ];
      case "failed":
        return [name, outcome.source, `failed: ${outcome.reason}`];
      case "skipped":
        return [name, "-", `skipped: ${outcome.reason}`];
    }
  });
  const table = [["machine", "source", "result"], ...cells];
  const widths = [0, 1].map((column) => Math.max(...table.map((row) => row[column]?.length ?? 0)));
  return table
    .map(
      ([a = "", b = "", c = ""]) =>
        `${a.padEnd(widths[0] ?? 0)}   ${b.padEnd(widths[1] ?? 0)}   ${c}`,
    )
    .join("\n");
}

async function main() {
  const options = new Command("ship:fleet")
    .description("Ship skills and packages to every Machine on the tailnet")
    .option("--dry-run", "print each Machine's plan and change nothing installed", false)
    .option("--only <machines...>", "ship only to these Machines")
    .parse()
    .opts<{ dryRun: boolean; only?: string[] }>();

  const tailnet = readTailnet();
  const slug = repoSlug();
  const unknown =
    options.only?.filter((name) => !tailnet.fleet.some((machine) => machine.name === name)) ?? [];
  if (unknown.length > 0) {
    console.error(
      `unknown Machine: ${unknown.join(", ")} (the tailnet has: ${tailnet.fleet.map((m) => m.name).join(", ")})`,
    );
    process.exit(1);
  }

  const targets = tailnet.fleet.filter((machine) => options.only?.includes(machine.name) ?? true);
  const width = Math.max(...targets.map((machine) => machine.name.length));
  const rows = await Promise.all(
    targets.map(async (machine) => ({
      name: machine.name,
      outcome: await shipTo(machine, tailnet.self.name, slug, options.dryRun, width),
    })),
  );
  console.log(`\n${summaryTable(rows)}`);
  process.exitCode = rows.some((row) => row.outcome.kind === "failed") ? 1 : 0;
}

if (import.meta.main) await main();
