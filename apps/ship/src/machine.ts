// `pnpm ship:machine`: ship this checkout to this Machine, printing the event
// ledger. ship:fleet runs it here against the working copy and on every other
// Machine against its Managed Clone (with --remote), and with --report reads
// its events and report as protocol lines instead.

import { Command, Option } from "commander";
import { createLedger } from "./ledger.ts";
import { describeChanges, formatEvent, formatReport, type MachineReport } from "./report.ts";
import { describeHead, manifestPath, REPO_ROOT, repoSlug } from "./repo.ts";
import { shipMachine } from "./ship-machine.ts";
import { ValidationError } from "./source.ts";
import { readTailnet } from "./tailnet.ts";

const options = new Command("ship:machine")
  .description("Ship this checkout's skills and packages to this Machine")
  .option("--dry-run", "print the plan and change nothing", false)
  .addOption(
    new Option("--remote", "this Machine did not start the Ship (set by ship:fleet)")
      .default(false)
      .hideHelp(),
  )
  .addOption(
    new Option("--report", "print protocol lines for ship:fleet").default(false).hideHelp(),
  )
  .parse()
  .opts<{ dryRun: boolean; remote: boolean; report: boolean }>();

const source = `${options.remote ? "origin/main" : "working copy"} ${describeHead()}`;
const tailnet = readTailnet();
const ledger = createLedger(tailnet.self.name.length);
let report: MachineReport;
try {
  const slug = repoSlug();
  report = shipMachine({
    root: REPO_ROOT,
    slug,
    manifestPath: manifestPath(slug),
    machine: {
      name: tailnet.self.name,
      platform: tailnet.self.platform,
      starting: !options.remote,
    },
    knownMachines: tailnet.fleet.map((machine) => machine.name),
    source,
    dryRun: options.dryRun,
    emit: (event) =>
      options.report
        ? console.log(formatEvent(event))
        : ledger.line(tailnet.self.name, event.tag, event.message),
  });
} catch (error) {
  // Validation errors are for the person shipping; anything else is a bug.
  const message =
    error instanceof ValidationError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  report = {
    source,
    skills: 0,
    added: [],
    removed: [],
    packages: [],
    failures: [message],
    dryRun: options.dryRun,
  };
}

if (options.report) console.log(formatReport(report));
else if (report.failures.length > 0) {
  ledger.fail(tailnet.self.name, report.failures.join("\n").split("\n"));
} else if (!report.dryRun) ledger.line(tailnet.self.name, "OK", describeChanges(report));
process.exitCode = report.failures.length > 0 ? 1 : 0;
