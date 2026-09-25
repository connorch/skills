// What a machine Ship reports back. With --report, ship:machine prints it as
// its last line; ship:fleet reads it from each Machine to build the summary.

import { z } from "zod";

const REPORT_PREFIX = "ship-report ";

export const MachineReport = z.object({
  // e.g. "working copy 1a2b3c4+dirty" or "origin/main 1a2b3c4".
  source: z.string(),
  skills: z.number(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  packages: z.array(z.string()),
  failures: z.array(z.string()),
  dryRun: z.boolean(),
});
export type MachineReport = z.infer<typeof MachineReport>;

export function formatReport(report: MachineReport): string {
  return `${REPORT_PREFIX}${JSON.stringify(report)}`;
}

// Undefined for ordinary output and for a report cut off mid-line (a dropped
// connection), which then counts as a Machine that never reported.
export function parseReport(line: string): MachineReport | undefined {
  if (!line.startsWith(REPORT_PREFIX)) return undefined;
  try {
    const parsed = MachineReport.safeParse(JSON.parse(line.slice(REPORT_PREFIX.length)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// One-line change summary, e.g. "14 skills (+1 -2), wovn-cli".
export function describeChanges(report: MachineReport): string {
  const delta = [
    report.added.length > 0 ? `+${report.added.length}` : "",
    report.removed.length > 0 ? `-${report.removed.length}` : "",
  ].filter(Boolean);
  const skills = `${report.skills} skills${delta.length > 0 ? ` (${delta.join(" ")})` : ""}`;
  return [skills, ...report.packages].join(", ");
}
