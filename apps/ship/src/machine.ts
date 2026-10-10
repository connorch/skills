// `pnpm ship:machine`: install this checkout's skills, Agent Instructions, and
// CLIs on this Machine. fleetfizz runs it as this repo's Install Command in
// every Machine's Managed Clone; run it by hand to install a working copy.
// Output is one tagged line per event; on failure it exits non-zero, which is
// how fleetfizz learns the install failed.

import { Command } from "commander";
import { readContext } from "./context.ts";
import { describeHead, manifestPath, REPO_ROOT, repoSlug } from "./repo.ts";
import { shipMachine, type MachineReport } from "./ship-machine.ts";
import { ValidationError } from "./source.ts";

const { dryRun } = new Command("ship:machine")
  .description("Install this checkout's skills and packages on this Machine")
  .option("--dry-run", "print the plan and change nothing", false)
  .parse()
  .opts<{ dryRun: boolean }>();

const line = (tag: string, message: string) => console.log(`${tag.padEnd(4)}  ${message}`);

// The result line, e.g. "15 skills (+2 -1) · wovn-cli".
function describeChanges(report: MachineReport): string {
  const delta = [
    report.added.length > 0 ? `+${report.added.length}` : "",
    report.removed.length > 0 ? `-${report.removed.length}` : "",
  ].filter(Boolean);
  const skills = `${report.skills} skills${delta.length > 0 ? ` (${delta.join(" ")})` : ""}`;
  return [skills, ...report.packages].join(" · ");
}

const source = describeHead();
let report: MachineReport;
try {
  const context = readContext();
  const slug = repoSlug();
  report = shipMachine({
    root: REPO_ROOT,
    slug,
    manifestPath: manifestPath(slug),
    machine: context.machine,
    knownMachines: context.knownMachines,
    source,
    dryRun,
    emit: (event) => line(event.tag, event.message),
  });
} catch (error) {
  // Validation errors are for the person shipping; anything else is a bug.
  const message =
    error instanceof ValidationError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  report = { source, skills: 0, added: [], removed: [], packages: [], failures: [message], dryRun };
}

if (report.failures.length > 0) {
  line("FAIL", report.failures.join("\n"));
  process.exitCode = 1;
} else if (!report.dryRun) line("OK", describeChanges(report));
