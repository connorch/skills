import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { PrinterAuthError, PrinterConnectionError } from "./client.ts";
import { freshState, type Event } from "./events.ts";
import { fileStore, limitsFor, watch, type WatchDependencies } from "./monitor.ts";
const printer = { host: "ip", serial: "serial", accessCode: "secret" };
const running = { gcode_state: "RUNNING", mc_percent: 10, layer_num: 5, total_layer_num: 100 },
  idle = { gcode_state: "IDLE", mc_percent: 0 },
  finish = { gcode_state: "FINISH", mc_percent: 100 };
function harness(reports: (Record<string, unknown> | Error)[]) {
  let time = 0,
    state = freshState();
  const events: Event[] = [],
    logged: Event[] = [],
    diagnostics: string[] = [],
    sleeps: number[] = [];
  const deps: WatchDependencies = {
    read: async () => {
      const item = reports.shift();
      if (item instanceof Error) throw item;
      if (!item) throw new Error("script exhausted");
      return item;
    },
    store: {
      load: () => structuredClone(state),
      save: (s) => {
        state = structuredClone(s);
      },
      append: (e) => {
        logged.push(e);
      },
    },
    now: () => time,
    sleep: async (seconds) => {
      sleeps.push(seconds);
      time += seconds;
    },
    announce: (e) => {
      events.push(e);
    },
    diagnostic: (m) => {
      diagnostics.push(m);
    },
  };
  return { deps, events, logged, diagnostics, sleeps };
}
const options = { interval: 120, waitStart: 0, once: false };
describe("upstream monitor polling", () => {
  it("stops immediately when idle", async () => {
    const h = harness([idle]);
    expect(await watch(printer, limitsFor("P1S"), options, h.deps)).toBe(0);
    expect(h.diagnostics).toContain("No print running; monitor stopped.");
    expect(h.sleeps).toEqual([]);
  });
  it("waits at 30-second intervals, watches then exits on finish", async () => {
    const h = harness([idle, idle, running, { ...running, layer_num: 6 }, finish]);
    expect(await watch(printer, limitsFor("P1S"), { ...options, waitStart: 5 }, h.deps)).toBe(0);
    expect(h.events.map((e) => e.kind)).toEqual(["started", "finished"]);
    expect(h.logged).toEqual(h.events);
    expect(h.sleeps).toEqual([30, 30, 120, 120]);
  });
  it("times out waiting for a print", async () => {
    const h = harness([idle, idle, idle]);
    expect(await watch(printer, limitsFor(), { ...options, waitStart: 1 }, h.deps)).toBe(0);
    expect(h.diagnostics[0]).toContain("within 1 min");
  });
  it("gives up after ten failed checks", async () => {
    const h = harness([
      running,
      ...Array.from({ length: 10 }, () => new PrinterConnectionError("no report")),
    ]);
    expect(await watch(printer, limitsFor(), options, h.deps)).toBe(1);
    expect(h.events.at(-1)?.title).toBe("Monitor stopped");
    expect(h.diagnostics.at(-1)).toContain("10/10");
  });
  it("resets failure count after recovery and stops immediately on auth errors", async () => {
    const h = harness([
      new PrinterConnectionError("offline"),
      running,
      new PrinterConnectionError("offline"),
      finish,
    ]);
    expect(await watch(printer, limitsFor(), options, h.deps)).toBe(0);
    expect(h.diagnostics.every((d) => d.includes("1/10"))).toBe(true);
    const auth = harness([new PrinterAuthError("Not authorized")]);
    expect(await watch(printer, limitsFor(), options, auth.deps)).toBe(1);
    expect(auth.sleeps).toEqual([]);
  });
  it("persists once state and clears stale state for new sessions", async () => {
    const h = harness([running, finish, finish]);
    expect(await watch(printer, limitsFor(), { ...options, once: true }, h.deps)).toBe(0);
    expect(await watch(printer, limitsFor(), { ...options, once: true }, h.deps)).toBe(0);
    expect(h.events.map((e) => e.kind)).toEqual(["started", "finished"]);
    await watch(printer, limitsFor(), options, h.deps);
    expect(h.events).toHaveLength(2);
  });
  it("once fails without retry and rejects invalid intervals", async () => {
    const h = harness([new PrinterConnectionError("offline")]);
    expect(await watch(printer, limitsFor(), { ...options, once: true }, h.deps)).toBe(1);
    expect(h.sleeps).toEqual([]);
    await expect(watch(printer, limitsFor(), { ...options, interval: 9 }, h.deps)).rejects.toThrow(
      "at least 10",
    );
  });
  it.each([
    ["H2D", 350, 120],
    ["H2S", 350, 120],
    ["H2D Pro", 350, 120],
    ["X1E", 320, 110],
    ["A1 Mini", 300, 80],
    ["a2l", 300, 80],
    ["X1 Carbon", 300, 110],
    ["P1S", 300, 100],
    ["Ender 3", 350, 120],
    ["", 350, 120],
  ])("uses hardware ratings %s", (model, nozzle, bed) => {
    expect(limitsFor(model)).toEqual({ nozzle_c: nozzle, bed_c: bed });
  });
  it("atomically persists state and trims logs at upstream thresholds", () => {
    const dir = mkdtempSync(join(tmpdir(), "bambu-monitor-"));
    try {
      const store = fileStore(dir, dir);
      expect(store.load()).toEqual(freshState());
      const state = { ...freshState(), watching: true, job: "cat" };
      store.save(state);
      expect(store.load()).toEqual(state);
      writeFileSync(join(dir, "monitor-state.json"), "bad json");
      expect(store.load()).toEqual(freshState());
      const event: Event = {
        kind: "started",
        severity: "info",
        title: "Watching print",
        message: "cat",
      };
      store.append(event, 0);
      const path = join(dir, "bambu-output", "monitor", "events.jsonl");
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject(event);
      writeFileSync(
        path,
        Array.from({ length: 1000 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n",
      );
      store.append(event, 1);
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(500);
      expect(JSON.parse(lines[0]!)).toEqual({ i: 501 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
