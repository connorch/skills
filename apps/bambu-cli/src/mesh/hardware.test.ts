import { describe, expect, it } from "vite-plus/test";
import {
  material,
  materialIssues,
  materials,
  printer,
  printers,
  usableVolume,
  volumes,
} from "./hardware.ts";
import { decideUnits } from "./units.ts";
describe("upstream hardware tables", () => {
  it("has the thirteen supported printers and their published facts", () => {
    expect(printers.map((p) => p.key)).toEqual([
      "A1 Mini",
      "A1",
      "A2L",
      "P1P",
      "P1S",
      "P2S",
      "X1C",
      "X1E",
      "X2D",
      "H2C",
      "H2S",
      "H2D",
      "H2D Pro",
    ]);
    expect(printers.filter((p) => p.discontinued).map((p) => p.key)).toEqual(["P1P", "X1C", "X1E"]);
    expect(volumes(printer("H2C"))).toMatchObject({
      plate: [330, 320, 325],
      left: [325, 320, 320],
      right: [305, 320, 325],
    });
    expect(printer("H2C").extruders[1]!.max_hotends).toBe(6);
  });
  it.each([
    ["a1 mini", "A1 Mini"],
    ["A1M", "A1 Mini"],
    ["Bambu Lab A1 mini", "A1 Mini"],
    ["X1 Carbon", "X1C"],
    ["x1-carbon", "X1C"],
    ["BL-P001", "X1C"],
    ["H2DP", "H2D Pro"],
    ["O1E", "H2D Pro"],
    ["O1C2", "H2C"],
    ["  p1s ", "P1S"],
  ])("resolves %s", (name, key) => expect(printer(name).key).toBe(key));
  it("lists names for unknown printers", () =>
    expect(() => printer("Ender 3")).toThrow("Known printers: A1 Mini, A1, A2L"));
  it.each([
    ["H2S", 350, 120],
    ["H2D Pro", 350, 120],
    ["X1E", 320, 110],
    ["A1 Mini", 300, 80],
    ["A2L", 300, 80],
  ])("rated temperatures for %s", (key, nozzle, bed) =>
    expect([printer(String(key)).max_nozzle_c, printer(String(key)).max_bed_c]).toEqual([
      nozzle,
      bed,
    ]),
  );
  it("takes XY margins from the common nozzle region", () => {
    expect(usableVolume(printer("A1"))).toEqual([246, 246, 256]);
    expect(usableVolume(printer("H2D"))).toEqual([290, 310, 320]);
    expect(usableVolume(printer("H2D"), 5, "right")).toEqual([315, 310, 325]);
    expect(usableVolume(printer("X2D"), 0)).toEqual([235.5, 256, 256]);
    expect(() => usableVolume(printer("A1"), -1)).toThrow("negative");
    expect(() => usableVolume(printer("A1"), 200)).toThrow("leaves no room");
    expect(() => usableVolume(printer("A1"), 5, "left")).toThrow("no 'left' region");
  });
  it.each([
    ["pla", "PLA"],
    ["PLA+", "PLA"],
    ["TPU", "TPU 95A"],
    ["tpu 95a hf", "TPU 95A"],
    ["PAHT-CF", "PA-CF"],
    ["Support W", "Support for PLA"],
    ["TPU-AMS", "TPU for AMS"],
  ])("material alias %s", (name, key) => expect(material(name).key).toBe(key));
  it("explicitly rejects PEEK and records abrasive and AMS requirements", () => {
    expect(() => material("peek")).toThrow("350 °C");
    expect(
      materials
        .filter((m) => m.abrasive)
        .map((m) => m.key)
        .sort(),
    ).toEqual(["PLA-CF", "PETG-CF", "PA-CF", "PPA-CF", "PPS-CF"].sort());
    expect(material("TPU").ams_compatible).toBe(false);
    expect(material("TPU-AMS").ams_compatible).toBe(true);
  });
  it("explains all unsuitable hardware combinations", () => {
    expect(materialIssues(printer("H2D"), material("PPS-CF"))).toEqual([]);
    expect(materialIssues(printer("A1"), material("ABS"))).toEqual([
      "ABS needs an enclosed printer; the A1 is open-frame.",
    ]);
    expect(materialIssues(printer("P1S"), material("PPS-CF"))).toHaveLength(4);
  });
});
describe("upstream unit evidence", () => {
  it("prioritizes the flag, then 3MF declaration, then size", () => {
    expect(decideUnits(1, { requested: "cm", declared: "inch" })).toMatchObject({
      unit: "cm",
      scale: 10,
      source: "flag",
    });
    expect(decideUnits(1, { declared: "inch" })).toMatchObject({
      unit: "in",
      scale: 25.4,
      source: "file",
    });
    expect(decideUnits(0.04)).toMatchObject({
      unit: "m",
      scale: 1000,
      source: "size",
      doubtful: true,
    });
    expect(decideUnits(4)).toMatchObject({
      unit: "mm",
      scale: 1,
      source: "assumed",
      doubtful: true,
    });
    expect(decideUnits(30).doubtful).toBe(false);
  });
});
