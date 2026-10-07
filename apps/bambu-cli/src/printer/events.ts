import { z } from "zod";
import { formatMinutes, type PrinterStatus } from "./report.ts";

export interface Limits {
  nozzle_c: number;
  bed_c: number;
}
export interface Event {
  kind: "started" | "progress" | "paused" | "alert" | "finished" | "failed" | "stopped";
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
}
const nullableNumber = z.number().nullable().default(null);
export const StateSchema = z.object({
  watching: z.boolean().default(false),
  job: z.string().default(""),
  last_layer: nullableNumber,
  last_remaining: nullableNumber,
  last_change_at: nullableNumber,
  last_progress_at: nullableNumber,
  announced: z.array(z.string()).default([]),
});
export type MonitorState = z.infer<typeof StateSchema>;
export function freshState(): MonitorState {
  return StateSchema.parse({});
}
export function restoreState(raw: unknown): MonitorState {
  const parsed = StateSchema.safeParse(raw);
  return parsed.success ? parsed.data : freshState();
}
function summary(s: PrinterStatus) {
  return (
    [
      s.file,
      s.progress_pct === null ? "" : `${s.progress_pct}%`,
      s.layer !== null && s.total_layers ? `layer ${s.layer}/${s.total_layers}` : "",
      s.remaining_min === null ? "" : `${formatMinutes(s.remaining_min)} left`,
    ]
      .filter(Boolean)
      .join(" · ") || s.state
  );
}
// Quarter marks a long print reports as it passes them.
const MILESTONES = [25, 50, 75] as const;
function minutesSince(then: number | null, now: number) {
  return then === null ? Infinity : (now - then) / 60;
}

// Evaluate a snapshot with a clock in seconds, updating the carried state in place.
export function evaluate(
  s: PrinterStatus,
  state: MonitorState,
  now: number,
  limits: Limits = { nozzle_c: 300, bed_c: 120 },
): Event[] {
  const events: Event[] = [];
  if (s.active && !state.watching) {
    Object.assign(state, freshState(), {
      watching: true,
      job: s.file,
      last_change_at: now,
      last_progress_at: now,
      // Marks already behind a print joined midway are not news.
      announced: MILESTONES.filter((m) => (s.progress_pct ?? 0) >= m).map((m) => `progress:${m}`),
    });
    events.push({
      kind: "started",
      severity: "info",
      title: "Watching print",
      message: summary(s),
    });
  }
  if (!state.watching) return events;
  let end: Event | undefined;
  if (s.state === "FINISH")
    end = {
      kind: "finished",
      severity: "info",
      title: "Print finished",
      message: `${s.file || "The print"} is done.`,
    };
  else if (s.state === "FAILED")
    end = {
      kind: "failed",
      severity: "critical",
      title: "Print failed",
      message: `The printer reports a failed print${s.print_error ? ` (error ${s.print_error})` : ""}.`,
    };
  else if (!s.active && s.state !== "UNKNOWN")
    end = {
      kind: "stopped",
      severity: "warning",
      title: "Print stopped",
      message: "The printer is idle again; the job was cancelled.",
    };
  if (end) {
    events.push(end);
    Object.assign(state, freshState());
    return events;
  }
  if (s.layer !== state.last_layer || s.remaining_min !== state.last_remaining) {
    state.last_layer = s.layer;
    state.last_remaining = s.remaining_min;
    state.last_change_at = now;
    state.announced = state.announced.filter((k) => k !== "stall");
  }
  const candidates: [string, Event][] = [];
  if (s.state === "PAUSE")
    candidates.push([
      "pause",
      {
        kind: "paused",
        severity: "warning",
        title: "Print paused",
        message:
          "Paused on the printer (filament runout, a detected problem, or by hand). Check the printer screen or Bambu Handy.",
      },
    ]);
  else state.announced = state.announced.filter((k) => k !== "pause");
  if (s.print_error)
    candidates.push([
      `error:${s.print_error}`,
      {
        kind: "alert",
        severity: "critical",
        title: "Printer error",
        message: `Error code ${s.print_error}; see the printer screen.`,
      },
    ]);
  for (const code of s.hms)
    candidates.push([
      `hms:${code}`,
      {
        kind: "alert",
        severity: "warning",
        title: "Printer warning",
        message: `HMS code ${code}.`,
      },
    ]);
  for (const [key, title, temp, rating] of [
    ["nozzle-temp", "Nozzle", s.nozzle_temp, limits.nozzle_c],
    ["bed-temp", "Bed", s.bed_temp, limits.bed_c],
  ] as const) {
    if (temp !== null && temp > rating + 10)
      candidates.push([
        key,
        {
          kind: "alert",
          severity: "critical",
          title: `${title} too hot`,
          message: `${title} at ${temp.toFixed(0)} °C, above the ${rating.toFixed(0)} °C rating.`,
        },
      ]);
  }
  if (s.state === "RUNNING" && minutesSince(state.last_change_at, now) >= 20)
    candidates.push([
      "stall",
      {
        kind: "alert",
        severity: "warning",
        title: "Print may be stuck",
        message: `No new layer and no change in time left for 20+ minutes (layer ${s.layer ?? "None"}/${s.total_layers ?? "None"}).`,
      },
    ]);
  for (const m of MILESTONES)
    if (s.progress_pct !== null && s.progress_pct >= m)
      candidates.push([
        `progress:${m}`,
        { kind: "progress", severity: "info", title: `${m}% printed`, message: summary(s) },
      ]);
  for (const [key, event] of candidates)
    if (!state.announced.includes(key)) {
      state.announced.push(key);
      events.push(event);
    }
  if (s.state === "RUNNING" && minutesSince(state.last_progress_at, now) >= 30) {
    state.last_progress_at = now;
    events.push({
      kind: "progress",
      severity: "info",
      title: "Print progress",
      message: summary(s),
    });
  }
  return events;
}
