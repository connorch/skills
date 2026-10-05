import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Printer } from "../config.ts";
import {
  PrinterAuthError,
  PrinterConnectionError,
  readReport,
  type ReportReader,
} from "./client.ts";
import {
  evaluate,
  freshState,
  restoreState,
  type Event,
  type Limits,
  type MonitorState,
} from "./events.ts";
import { parseStatus } from "./report.ts";
import ratings from "./ratings.json" with { type: "json" };

// Ratings copied from the vendored hardware table, including its model aliases.
export function limitsFor(model?: string | null): Limits {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rating = model
    ? ratings.find((r) => r.names.some((n) => normalize(n) === normalize(model)))
    : undefined;
  return rating
    ? { nozzle_c: rating.nozzle_c, bed_c: rating.bed_c }
    : {
        nozzle_c: Math.max(...ratings.map((r) => r.nozzle_c)),
        bed_c: Math.max(...ratings.map((r) => r.bed_c)),
      };
}
export interface MonitorStore {
  load(): MonitorState;
  save(state: MonitorState): void;
  append(event: Event, now: number): void;
}

// Keep scheduler state atomically and retain the last 500 log entries after 1000.
export function fileStore(configDir: string, cwd = process.cwd()): MonitorStore {
  const statePath = join(configDir, "monitor-state.json"),
    logPath = join(cwd, "bambu-output", "monitor", "events.jsonl");
  return {
    load() {
      try {
        return restoreState(JSON.parse(readFileSync(statePath, "utf8")));
      } catch {
        return freshState();
      }
    },
    save(state) {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
      renameSync(`${statePath}.tmp`, statePath);
    },
    append(event, now) {
      mkdirSync(dirname(logPath), { recursive: true });
      const date = new Date(now * 1000);
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 19);
      appendFileSync(logPath, `${JSON.stringify({ time: local, ...event })}\n`);
      const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
      if (lines.length > 1000) writeFileSync(logPath, `${lines.slice(-500).join("\n")}\n`);
    },
  };
}
export interface WatchOptions {
  interval: number;
  waitStart: number;
  once: boolean;
}
export interface WatchDependencies {
  read: ReportReader;
  store: MonitorStore;
  now(): number;
  sleep(seconds: number): Promise<unknown>;
  announce(event: Event): void;
  diagnostic(message: string): void;
}
export function defaultWatchDependencies(
  configDir: string,
  announce: (event: Event) => void,
): WatchDependencies {
  return {
    read: readReport,
    store: fileStore(configDir),
    now: () => Date.now() / 1000,
    sleep: (s) => delay(s * 1000),
    announce,
    diagnostic: (message) => console.error(message),
  };
}

// Poll until the Print Job ends, or check once using persisted scheduler state.
export async function watch(
  printer: Printer,
  limits: Limits,
  options: WatchOptions,
  deps: WatchDependencies,
): Promise<number> {
  if (!Number.isInteger(options.interval) || options.interval < 10)
    throw new RangeError("--interval must be at least 10 seconds");
  const state = options.once ? deps.store.load() : freshState();
  const deadline = deps.now() + options.waitStart * 60;
  let failures = 0,
    seenPrint = false;
  function announce(event: Event) {
    deps.announce(event);
    deps.store.append(event, deps.now());
  }
  while (true) {
    let status;
    try {
      status = parseStatus(await deps.read(printer));
      for (const event of evaluate(status, state, deps.now(), limits)) announce(event);
      deps.store.save(state);
      failures = 0;
    } catch (error) {
      if (!(error instanceof PrinterConnectionError)) throw error;
      if (error instanceof PrinterAuthError || options.once) {
        deps.diagnostic(error.message);
        return 1;
      }
      failures++;
      deps.diagnostic(`Check failed (${failures}/10): ${error.message}`);
      if (failures >= 10) {
        announce({
          kind: "alert",
          severity: "warning",
          title: "Monitor stopped",
          message: "Lost contact with the printer after 10 tries.",
        });
        return 1;
      }
      await deps.sleep(options.interval);
      continue;
    }
    if (options.once) return 0;
    if (state.watching || status.active) {
      seenPrint = true;
      await deps.sleep(options.interval);
    } else if (seenPrint) return 0;
    else if (deps.now() < deadline) await deps.sleep(30);
    else {
      deps.diagnostic(
        `${options.waitStart ? `No print started within ${options.waitStart} min` : "No print running"}; monitor stopped.`,
      );
      return 0;
    }
  }
}
