import { describe, expect, it } from "vite-plus/test";
import { evaluate, freshState, restoreState } from "./events.ts";
import { parseStatus } from "./report.ts";
const limits = { nozzle_c: 300, bed_c: 120 };
const status = (fields: Record<string, unknown> = {}) =>
  parseStatus({
    gcode_state: "RUNNING",
    mc_percent: 10,
    layer_num: 5,
    total_layer_num: 100,
    mc_remaining_time: 90,
    subtask_name: "cat",
    nozzle_temper: 220,
    bed_temper: 60,
    ...fields,
  });
const kinds = (events: ReturnType<typeof evaluate>) => events.map((e) => e.kind);
describe("upstream monitor events", () => {
  it("ignores idle and unknown, starts once and finishes with reset", () => {
    const state = freshState();
    expect(evaluate(status({ gcode_state: "IDLE" }), state, 0, limits)).toEqual([]);
    expect(kinds(evaluate(status(), state, 0, limits))).toEqual(["started"]);
    expect(evaluate(status({ gcode_state: "UNKNOWN" }), state, 60, limits)).toEqual([]);
    expect(kinds(evaluate(status({ gcode_state: "FINISH" }), state, 300, limits))).toEqual([
      "finished",
    ]);
    expect(state).toEqual(freshState());
  });
  it.each(["IDLE", "FAILED"])("reports ending %s", (gcode_state) => {
    const state = freshState();
    evaluate(status(), state, 0, limits);
    const events = evaluate(status({ gcode_state, print_error: 50348044 }), state, 60, limits);
    expect(kinds(events)).toEqual([gcode_state === "IDLE" ? "stopped" : "failed"]);
    if (gcode_state === "FAILED") {
      expect(events[0]?.severity).toBe("critical");
      expect(events[0]?.message).toContain("0300400C");
    }
  });
  it("announces each pause once, rearming after resume", () => {
    const state = freshState();
    evaluate(status(), state, 0, limits);
    expect(kinds(evaluate(status({ gcode_state: "PAUSE" }), state, 60, limits))).toEqual([
      "paused",
    ]);
    expect(evaluate(status({ gcode_state: "PAUSE" }), state, 120, limits)).toEqual([]);
    evaluate(status({ layer_num: 6 }), state, 180, limits);
    expect(
      kinds(evaluate(status({ gcode_state: "PAUSE", layer_num: 6 }), state, 240, limits)),
    ).toEqual(["paused"]);
  });
  it("tracks movement, reports stalls once, then rearms", () => {
    const state = freshState();
    evaluate(status(), state, 0, limits);
    for (let minute = 5; minute < 60; minute += 5)
      expect(
        evaluate(status({ layer_num: 5 + minute }), state, minute * 60, limits).some(
          (e) => e.kind === "alert",
        ),
      ).toBe(false);
    const frozen = status({ layer_num: 55 });
    evaluate(frozen, state, 3600, limits);
    expect(evaluate(frozen, state, 4200, limits)).toEqual([]);
    expect(evaluate(frozen, state, 4860, limits).map((e) => e.title)).toContain(
      "Print may be stuck",
    );
    expect(evaluate(frozen, state, 5400, limits).some((e) => e.kind === "alert")).toBe(false);
    evaluate(status({ layer_num: 56 }), state, 5500, limits);
    expect(evaluate(status({ layer_num: 56 }), state, 6700, limits).map((e) => e.title)).toContain(
      "Print may be stuck",
    );
  });
  it("does not stall or report progress while preparing", () => {
    const state = freshState(),
      s = status({ gcode_state: "PREPARE", layer_num: 0 });
    evaluate(s, state, 0, limits);
    expect(evaluate(s, state, 2400, limits)).toEqual([]);
  });
  it("deduplicates errors and HMS, but announces new codes", () => {
    const state = freshState();
    evaluate(status(), state, 0, limits);
    const faulty = status({ print_error: 50348044, hms: [{ attr: 50331904, code: 131079 }] });
    expect(evaluate(faulty, state, 60, limits).map((e) => e.severity)).toEqual([
      "critical",
      "warning",
    ]);
    expect(evaluate(faulty, state, 120, limits)).toEqual([]);
    expect(
      evaluate(status({ hms: [{ attr: 50331904, code: 131080 }] }), state, 180, limits),
    ).toHaveLength(1);
  });
  it.each([
    [305, false],
    [315, true],
  ])("uses nozzle rating plus margin: %s", (nozzle, alert) => {
    const state = freshState();
    evaluate(status(), state, 0, limits);
    expect(
      evaluate(status({ nozzle_temper: nozzle }), state, 60, limits).some(
        (e) => e.title === "Nozzle too hot",
      ),
    ).toBe(alert);
  });
  it("allows high-temperature printers and detects bed over-temperature", () => {
    const state = freshState();
    evaluate(status(), state, 0, { nozzle_c: 350, bed_c: 120 });
    expect(
      evaluate(status({ nozzle_temper: 345 }), state, 60, { nozzle_c: 350, bed_c: 120 }),
    ).toEqual([]);
    expect(evaluate(status({ bed_temper: 131 }), state, 120, limits)[0]?.title).toBe("Bed too hot");
  });
  it("reports progress every 30 minutes and round-trips state ignoring future keys", () => {
    const state = freshState();
    evaluate(status(), state, 0, limits);
    expect(evaluate(status({ layer_num: 6 }), state, 29 * 60, limits)).toEqual([]);
    expect(kinds(evaluate(status({ layer_num: 7 }), state, 31 * 60, limits))).toEqual(["progress"]);
    expect(restoreState({ ...JSON.parse(JSON.stringify(state)), future: 1 })).toEqual(state);
  });
});
