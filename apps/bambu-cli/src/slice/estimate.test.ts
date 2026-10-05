import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import {
  combineEstimates,
  parseDuration,
  parseGcodeHeader,
  parseResultJson,
  plateGcodes,
} from "./estimate.ts";
const result: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/result_p1s_box.json", import.meta.url), "utf8"),
);
const header = readFileSync(new URL("./fixtures/plate_1_header.gcode", import.meta.url), "utf8");
describe("upstream estimates", () => {
  it("uses total time including start sequence", () => {
    expect(parseResultJson(result)).toMatchObject({
      print_time_s: 1125.90185546875,
      filament_g: 5.082495212554932,
      plates: 1,
      source: "result.json",
      warnings: [],
      filaments: [{ slot: 1, filament_id: "GFA00", grams: 5.082495212554932 }],
    });
  });
  it("header has same estimate within one second", () => {
    const estimate = parseGcodeHeader(header.split("\n"));
    expect(estimate.print_time_s).toBe(1125);
    expect(estimate.filament_g).toBe(5.08);
    expect(estimate.filaments[0]?.filament_id).toBe("GFA00");
  });
  it("reads multiple filaments", () => {
    expect(
      parseGcodeHeader([
        "; model printing time: 1h 2m 3s; total estimated time: 1h 10m 0s",
        "; total filament weight [g] : 3.72,1.20",
        "; filament_ids = GFA00;GFB00",
        "; CONFIG_BLOCK_END",
      ]),
    ).toMatchObject({
      print_time_s: 4200,
      filaments: [
        { slot: 1, filament_id: "GFA00", grams: 3.72 },
        { slot: 2, filament_id: "GFB00", grams: 1.2 },
      ],
    });
  });
  it("sums plates and warnings", () => {
    const plate = {
      total_predication: 100,
      filaments: [{ id: 1, total_used_g: 2, filament_id: "GFA00" }],
    };
    expect(
      parseResultJson({
        sliced_plates: [plate, { ...plate, warning_message: " Floating regions " }],
      }),
    ).toMatchObject({
      plates: 2,
      print_time_s: 200,
      filament_g: 4,
      warnings: ["Floating regions"],
    });
  });
  it("failed slice has no estimate", () => {
    expect(() => parseResultJson({ return_code: -61 })).toThrow("no sliced plates");
  });
  it("missing time is an error", () => {
    expect(() => parseResultJson({ sliced_plates: [{}] })).toThrow("no total_predication");
  });
  it("sums every archived plate", () => {
    const archive = zipSync({
      "Metadata/plate_1.gcode": strToU8(header),
      "Metadata/plate_2.gcode": strToU8(header),
      "3D/3dmodel.model": strToU8("<model/>"),
    });
    expect(
      combineEstimates(
        [...plateGcodes(archive).values()].map((g) => parseGcodeHeader(g.split("\n"))),
      ),
    ).toMatchObject({ plates: 2, print_time_s: 2250, filament_g: 10.16 });
  });
  it("unsliced archive is an error", () => {
    expect(() => plateGcodes(zipSync({ "3D/3dmodel.model": strToU8("<model/>") }))).toThrow(
      "no plate G-code",
    );
  });
  it("malformed archive is an error", () => {
    expect(() => plateGcodes(strToU8("oops"))).toThrow("cannot read");
  });
  it("header needs total time", () => {
    expect(() => parseGcodeHeader(["; HEADER_BLOCK_START", "; CONFIG_BLOCK_END"])).toThrow(
      "no total estimated time",
    );
  });
  it.each([
    ["18m 45s", 1125],
    ["1h 2m 3s", 3723],
    ["1d 0h 0m 1s", 86401],
    ["45s", 45],
  ] as const)("duration %s", (text, seconds) => {
    expect(parseDuration(text)).toBe(seconds);
  });
  it("rejects non duration", () => {
    expect(() => parseDuration("soon")).toThrow("not a duration");
  });
});
