// `pnpm ship:fleet`: a Ship across the Fleet. This Machine ships its working
// copy; every other reachable Machine resets its Managed Clone to origin/main
// over `tailscale ssh` and runs ship:machine there. Machines run in parallel
// and share one event ledger; a failed Machine's output prints under its FAIL.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createLedger, type Ledger } from "./ledger.ts";
import { describeChanges, parseLine, type MachineReport } from "./report.ts";
import { cloneUrl, managedCloneDir, REPO_ROOT, repoSlug } from "./repo.ts";
import { readTailnet, type Machine } from "./tailnet.ts";

export type Outcome =
  | { kind: "ok"; report: MachineReport }
  // The first line says why; the rest is the Machine's output.
  | { kind: "failed"; details: string[] }
  | { kind: "skipped"; reason: string };

// `tailscale ssh` exits 255 when it cannot connect or the policy denies the login.
// Past that, exit codes mean nothing: Tailscale SSH on macOS reports 0 even
// when the remote command fails, so only the ship-report line counts as success.
const SSH_FAILURE = 255;

// `output` is the Machine's non-empty lines outside the protocol, in order.
export function outcomeOf(
  exitCode: number | null,
  report: MachineReport | undefined,
  output: string[],
): Outcome {
  if (report) {
    return report.failures.length === 0
      ? { kind: "ok", report }
      : { kind: "failed", details: [...report.failures.join("\n").split("\n"), ...output] };
  }
  // ssh explains a refused login first. A crashed script explains itself in
  // its last error line (Node prints its version after a crash, so not the last line).
  if (exitCode === SSH_FAILURE) {
    return {
      kind: "skipped",
      reason: `ssh: ${output[0]?.replace(/^tailscale: /, "") ?? "connection failed"}`,
    };
  }
  const reason =
    output.findLast((line) => /error/i.test(line)) ??
    output.at(-1) ??
    "exited without a ship report";
  return { kind: "failed", details: [reason, ...output] };
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
    // node directly, not `pnpm --silent ship:machine`, whose --silent also hides
    // pnpm's own errors (such as a missing script).
    `exec node apps/ship/src/machine.ts --remote --report${dryRun ? " --dry-run" : ""}`,
  ].join("\n");
}

function shipTo(
  machine: Machine,
  local: boolean,
  slug: string,
  dryRun: boolean,
  ledger: Ledger,
): Promise<Outcome> {
  const skip = (reason: string): Promise<Outcome> => {
    ledger.line(machine.name, "SKIP", reason);
    return Promise.resolve({ kind: "skipped", reason });
  };
  if (!machine.online) return skip("offline");
  if (!local && !machine.ssh) return skip("no Tailscale SSH server");

  const flags = ["--report", ...(dryRun ? ["--dry-run"] : [])];
  const child = local
    ? spawn(process.execPath, [fileURLToPath(new URL("machine.ts", import.meta.url)), ...flags], {
        cwd: REPO_ROOT,
      })
    : spawn("tailscale", ["ssh", machine.name, remoteScript(slug, dryRun)], {
        stdio: ["ignore", "pipe", "pipe"],
      });

  let report: MachineReport | undefined;
  const output: string[] = [];
  const read = (line: string) => {
    const parsed = parseLine(line);
    if (parsed.kind === "event") ledger.line(machine.name, parsed.event.tag, parsed.event.message);
    else if (parsed.kind === "report") report = parsed.report;
    else if (line.trim()) output.push(line.trimEnd());
  };
  createInterface({ input: child.stdout }).on("line", read);
  createInterface({ input: child.stderr }).on("line", read);

  return new Promise((resolve) => {
    const finish = (outcome: Outcome) => {
      if (outcome.kind === "ok" && !outcome.report.dryRun) {
        ledger.line(machine.name, "OK", describeChanges(outcome.report));
      } else if (outcome.kind === "failed") ledger.fail(machine.name, outcome.details);
      else if (outcome.kind === "skipped") ledger.line(machine.name, "SKIP", outcome.reason);
      resolve(outcome);
    };
    child.on("error", (error) => finish({ kind: "failed", details: [error.message] }));
    child.on("close", (code) => finish(outcomeOf(code, report, output)));
  });
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
  const names = tailnet.fleet.map((machine) => machine.name);
  const unknown = options.only?.filter((name) => !names.includes(name)) ?? [];
  if (unknown.length > 0) {
    console.error(`unknown Machine: ${unknown.join(", ")} (the tailnet has: ${names.join(", ")})`);
    process.exit(1);
  }

  const targets = tailnet.fleet.filter((machine) => options.only?.includes(machine.name) ?? true);
  const ledger = createLedger(Math.max("fleet".length, ...targets.map((m) => m.name.length)));
  const count = `${targets.length} machine${targets.length === 1 ? "" : "s"}`;
  ledger.line(
    "fleet",
    "INFO",
    [options.dryRun ? "dry run" : "", count, `local ${tailnet.self.name}`]
      .filter(Boolean)
      .join(", "),
  );

  const outcomes = await Promise.all(
    targets.map((machine) =>
      shipTo(machine, machine.name === tailnet.self.name, slug, options.dryRun, ledger),
    ),
  );
  const tally = (kind: Outcome["kind"]) =>
    outcomes.filter((outcome) => outcome.kind === kind).length;
  ledger.line(
    "fleet",
    "DONE",
    `${options.dryRun ? "planned" : "ok"} ${tally("ok")}  skipped ${tally("skipped")}  failed ${tally("failed")}`,
  );
  process.exitCode = tally("failed") > 0 ? 1 : 0;
}

if (import.meta.main) await main();
