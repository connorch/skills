import { describe, expect, it } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { ProfileLibrary } from "./profiles.ts";
import { printerKey, resolveProfiles } from "./resolve.ts";
const library = new ProfileLibrary(fileURLToPath(new URL("./fixtures/profiles", import.meta.url)));
describe("upstream preset selection", () => {
  it.each([
    ["P1S", "P1S"],
    ["p1s", "P1S"],
    ["a1 mini", "A1 Mini"],
    ["A1mini", "A1 Mini"],
    ["A1", "A1"],
    ["X1 Carbon", "X1C"],
    ["h2d-pro", "H2D Pro"],
    ["H2D", "H2D"],
    ["Bambu Lab P2S", "P2S"],
    ["X1", undefined],
    ["Unknown", undefined],
    ["", undefined],
  ])("normalizes %s", (typed, key) => {
    expect(printerKey(typed ?? "")).toBe(key);
  });
  it.each([
    ["A1", "Bambu Lab A1 0.4 nozzle", "0.20mm Standard @BBL A1", "Bambu PLA Basic @BBL A1"],
    [
      "A1 Mini",
      "Bambu Lab A1 mini 0.4 nozzle",
      "0.20mm Standard @BBL A1M",
      "Bambu PLA Basic @BBL A1M",
    ],
    ["H2D", "Bambu Lab H2D 0.4 nozzle", "0.20mm Standard @BBL H2D", "Bambu PLA Basic @BBL H2D"],
    [
      "H2D Pro",
      "Bambu Lab H2D Pro 0.4 nozzle",
      "0.20mm Standard @BBL H2DP",
      "Bambu PLA Basic @BBL H2DP",
    ],
    ["P2S", "Bambu Lab P2S 0.4 nozzle", "0.20mm Standard @BBL P2S", "Bambu PLA Basic @BBL P2S"],
  ])("selects exact family %s", (printer, machine, process, filament) => {
    expect(resolveProfiles(library, { printer })).toMatchObject({ machine, process, filament });
  });
  it("selects H2D PETG rather than H2DP", () => {
    expect(resolveProfiles(library, { printer: "H2D", material: "Bambu PETG HF" }).filament).toBe(
      "Bambu PETG HF @BBL H2D 0.4 nozzle",
    );
  });
  it("selects nozzle throughout graph", () => {
    expect(resolveProfiles(library, { printer: "P1S", nozzle_mm: 0.8 })).toMatchObject({
      nozzle: "0.8",
      machine: "Bambu Lab P1S 0.8 nozzle",
      process: "0.40mm Standard @BBL X1C 0.8 nozzle",
      filament: "Bambu PLA Basic @BBL X1C 0.8 nozzle",
      layer_height_mm: 0.4,
    });
  });
  it.each([
    ["P1S", "PLA", "Bambu PLA Basic @BBL P1S 0.4 nozzle"],
    ["P1S", "pla", "Bambu PLA Basic @BBL P1S 0.4 nozzle"],
    ["P1S", "PETG", "Generic PETG"],
    ["A1", "PETG", "Generic PETG @BBL A1"],
    ["A1", "Bambu PLA Basic", "Bambu PLA Basic @BBL A1"],
    ["A1", "Bambu PLA Basic @BBL A1", "Bambu PLA Basic @BBL A1"],
  ])("material %s %s", (printer, material, filament) => {
    expect(resolveProfiles(library, { printer, material }).filament).toBe(filament);
  });
  it.each([
    { printer: "P1S", quality: "standard", process: "0.20mm Standard @BBL X1C" },
    { printer: "P1S", quality: "fine", process: "0.12mm Fine @BBL X1C" },
    { printer: "P1S", quality: "draft", process: "0.24mm Draft @BBL X1C" },
    { printer: "A1", quality: "draft", process: "0.24mm Draft @BBL A1" },
    { printer: "H2D", quality: "draft", process: "0.24mm Standard @BBL H2D" },
    { printer: "H2D", quality: "fine", process: "0.12mm Fine @BBL H2D" },
  ] as const)("quality $printer $quality", ({ printer, quality, process }) => {
    expect(resolveProfiles(library, { printer, quality }).process).toBe(process);
  });
  it("exact height prefers everyday preset", () => {
    expect(resolveProfiles(library, { printer: "P1S", layer_height_mm: 0.16 }).process).toBe(
      "0.16mm Optimal @BBL X1C",
    );
  });
  it("reports available heights", () => {
    expect(() => resolveProfiles(library, { printer: "P1S", layer_height_mm: 0.3 })).toThrow(
      "0.12, 0.16, 0.2, 0.24",
    );
  });
  it("reports available nozzles", () => {
    expect(() => resolveProfiles(library, { printer: "P2S", nozzle_mm: 0.6 })).toThrow(
      "Nozzles: 0.4 mm",
    );
  });
  it("reports available materials", () => {
    expect(() => resolveProfiles(library, { printer: "P1S", material: "PEEK" })).toThrow(
      /Materials: .*PETG.*PLA/,
    );
  });
  it("asks to update for missing family", () => {
    expect(() => resolveProfiles(library, { printer: "X2D" })).toThrow("Update Bambu Studio");
  });
  it("rejects unknown printer", () => {
    expect(() => resolveProfiles(library, { printer: "Ender 3" })).toThrow("Unknown printer");
  });
  it("reads family default Plate", () => {
    expect(resolveProfiles(library, { printer: "A1 Mini" }).bed_type).toBe("Textured PEI Plate");
  });
});
