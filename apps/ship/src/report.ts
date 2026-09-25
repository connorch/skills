// The line protocol between ship:machine and ship:fleet. With --report,
// ship:machine prints its events and, last, its report as prefixed JSON lines;
// every other line it prints (a crash, a build log) is plain text that
// ship:fleet only shows when that Machine fails.

import { z } from "zod";

const EVENT_PREFIX = "ship-event ";
const REPORT_PREFIX = "ship-report ";

// Progress from inside a machine Ship: its plan, and each package it runs.
export const ShipEvent = z.object({
  tag: z.enum(["PLAN", "RUN"]),
  message: z.string(),
});
export type ShipEvent = z.infer<typeof ShipEvent>;

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

export function formatEvent(event: ShipEvent): string {
  return `${EVENT_PREFIX}${JSON.stringify(event)}`;
}

export function formatReport(report: MachineReport): string {
  return `${REPORT_PREFIX}${JSON.stringify(report)}`;
}

export type Line =
  | { kind: "event"; event: ShipEvent }
  | { kind: "report"; report: MachineReport }
  | { kind: "text"; text: string };

function parseJson<T>(schema: z.ZodType<T>, json: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// A protocol line cut off mid-line (a dropped connection) reads as plain text,
// so that Machine counts as one that never reported.
export function parseLine(line: string): Line {
  if (line.startsWith(EVENT_PREFIX)) {
    const event = parseJson(ShipEvent, line.slice(EVENT_PREFIX.length));
    if (event) return { kind: "event", event };
  }
  if (line.startsWith(REPORT_PREFIX)) {
    const report = parseJson(MachineReport, line.slice(REPORT_PREFIX.length));
    if (report) return { kind: "report", report };
  }
  return { kind: "text", text: line };
}

// The result line, e.g. "15 skills (+2 -1) · wovn-cli".
export function describeChanges(report: MachineReport): string {
  const delta = [
    report.added.length > 0 ? `+${report.added.length}` : "",
    report.removed.length > 0 ? `-${report.removed.length}` : "",
  ].filter(Boolean);
  const skills = `${report.skills} skills${delta.length > 0 ? ` (${delta.join(" ")})` : ""}`;
  return [skills, ...report.packages].join(" · ");
}
