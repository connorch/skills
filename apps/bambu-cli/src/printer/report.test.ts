import { describe, expect, it } from "vite-plus/test";
import fixture from "./fixtures/p1s_printing.json" with { type: "json" };
import { formatStatus, parseStatus, parseTrays, trayLabel } from "./report.ts";
import { ReportCollector } from "./client.ts";

describe("upstream printer reports", () => {
  it("parses recorded state, temperatures, speed and off light", () => {
    const s = parseStatus(fixture.print);
    expect(s).toMatchObject({
      state: "RUNNING",
      active: true,
      progress_pct: 42,
      remaining_min: 71,
      layer: 57,
      total_layers: 136,
      file: "cat_figurine",
      nozzle_temp: 219.8,
      nozzle_target: 220,
      bed_temp: 59.9,
      bed_target: 60,
      speed: "standard",
      light: "off",
      print_error: null,
      hms: ["0300_0100_0002_0007"],
    });
    expect(formatStatus(s, "P1S")).toContain("RUNNING · 42% · layer 57/136 · 1 h 11 min left");
    expect(formatStatus(s)).toContain("Light off");
    expect(formatStatus(s)).toContain("▶ A2");
  });
  it("skips empty Slots and preserves active, colour and unknown remaining", () => {
    const slots = parseTrays(fixture.print);
    expect(slots.map((s) => [s.unit, s.slot])).toEqual([
      [0, 0],
      [0, 1],
      [0, 3],
    ]);
    expect(slots.map((s) => s.active)).toEqual([false, true, false]);
    expect(slots[1]).toMatchObject({ color: "#FF6A13", name: "PLA Basic" });
    expect(slots[2]?.remaining_pct).toBeNull();
    expect(JSON.parse(JSON.stringify(slots))[1].color).toBe("#FF6A13");
  });
  it("includes an external spool and HT feeding", () => {
    const s = parseTrays({
      ...fixture.print,
      ams: { tray_now: "254" },
      vt_tray: { tray_type: "TPU", tray_color: "112233FF" },
    });
    expect(s[0]).toMatchObject({ unit: null, material: "TPU", active: true, color: "#112233" });
    const ht = parseTrays({
      ams: { tray_now: "128", ams: [{ id: "128", tray: [{ id: "0", tray_type: "PLA" }] }] },
    });
    expect(ht[0]?.active).toBe(true);
    expect(trayLabel(ht[0]!)).toBe("HT1");
    expect(trayLabel(s[0]!)).toBe("Ext");
  });
  it("decodes error codes and defaults missing or malformed fields", () => {
    expect(parseStatus({ print_error: 50348044 }).print_error).toBe("0300400C");
    expect(parseStatus({})).toMatchObject({
      state: "UNKNOWN",
      active: false,
      nozzle_temp: null,
      speed: null,
      light: null,
      trays: [],
    });
    expect(
      parseStatus({
        mc_percent: true,
        layer_num: -1,
        spd_lvl: 99,
        hms: [{ attr: false, code: 2 }],
      }),
    ).toMatchObject({ progress_pct: null, layer: null, speed: null, hms: [] });
    expect(parseStatus({ gcode_state: "IDLE" }).active).toBe(false);
  });
  it("merges partial reports and ignores invalid payloads until the required full snapshot", () => {
    const c = new ReportCollector();
    expect(c.feed('{"print":{"nozzle_temper":30}}')).toBe(false);
    expect(c.feed("not json")).toBe(false);
    expect(c.feed('{"info":{}}')).toBe(false);
    expect(c.feed('{"print":{"gcode_state":"IDLE"}}')).toBe(false);
    expect(c.feed('{"print":{"mc_percent":0}}')).toBe(true);
    expect(c.report).toEqual({ nozzle_temper: 30, gcode_state: "IDLE", mc_percent: 0 });
  });
});
