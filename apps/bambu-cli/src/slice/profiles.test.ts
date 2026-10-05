import { describe, expect, it } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { ProfileLibrary, type Profile, type Kind } from "./profiles.ts";
export const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const library = new ProfileLibrary(`${fixtures}/profiles`);
function bundle(presets: [Kind, string, Profile, string?][]) {
  const files = new Map<string, string>();
  const index: Record<string, unknown> = { version: "1" };
  for (const kind of ["machine", "process", "filament"])
    index[`${kind}_list`] = presets
      .filter((p) => p[0] === kind)
      .map(([, name, , path]) => ({ name, sub_path: path ?? `${kind}/${name}.json` }));
  files.set("/bundle/BBL.json", JSON.stringify(index));
  for (const [kind, name, data, path] of presets)
    files.set(`/bundle/BBL/${path ?? `${kind}/${name}.json`}`, JSON.stringify(data));
  return new ProfileLibrary("/bundle", {
    read: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    realpath: (path) => path,
  });
}
describe("upstream profile flattening", () => {
  it("retains leaf identity and inherited filament id, excludes links", () => {
    const name = "Bambu PLA Basic @BBL P1S 0.4 nozzle";
    expect(library.raw("filament", name).include).toEqual(["fdm_filament_template_direct_dual"]);
    const flat = library.flatten("filament", name);
    expect(flat).toMatchObject({
      name,
      setting_id: "GFSA00_34",
      instantiation: "true",
      from: "system",
      type: "filament",
      filament_id: "GFA00",
      filament_flow_ratio: ["0.98", "0.985"],
    });
    expect(flat).not.toHaveProperty("inherits");
    expect(flat).not.toHaveProperty("include");
  });
  it("merges the whole machine chain", () => {
    expect(library.raw("machine", "Bambu Lab P1S 0.4 nozzle")).not.toHaveProperty("printable_area");
    expect(library.flatten("machine", "Bambu Lab P1S 0.4 nozzle")).toMatchObject({
      setting_id: "GM014",
      printable_area: ["0x0", "256x0", "256x256", "0x256"],
      printer_model: "Bambu Lab P1S",
      default_print_profile: "0.20mm Standard @BBL X1C",
    });
  });
  it("copies G-code templates verbatim", () => {
    const flat = library.flatten("machine", "Bambu Lab P1S 0.4 nozzle");
    const includes = library.raw("machine", "Bambu Lab P1S 0.4 nozzle").include;
    if (!Array.isArray(includes)) throw new Error("missing includes");
    for (const include of includes) {
      if (typeof include !== "string") throw new Error("invalid include");
      for (const [key, value] of Object.entries(library.raw("machine", include)))
        if (key.endsWith("_gcode")) expect(flat[key]).toEqual(value);
    }
  });
  it("own include wins over parent include", () => {
    const flat = library.flatten("machine", "Bambu Lab P1S 0.8 nozzle");
    expect(flat.machine_start_gcode).toBe(
      library.raw("machine", "Bambu Lab P1S 0.8 nozzle template machine_start_gcode")
        .machine_start_gcode,
    );
    expect(flat).toMatchObject({ setting_id: "GM017", nozzle_diameter: ["0.8"] });
  });
  it("returns a copy", () => {
    library.flatten("process", "0.20mm Standard @BBL X1C").layer_height = "9";
    expect(library.flatten("process", "0.20mm Standard @BBL X1C").layer_height).toBe("0.2");
  });
  it("only exposes selectable instances", () => {
    const names = library.instances("filament").map(([name]) => name);
    expect(names).toContain("Bambu PLA Basic @BBL A1");
    expect(names).not.toContain("Bambu PLA Basic @base");
    expect(names).not.toContain("fdm_filament_template_direct_dual");
  });
  it("uses index names, not file names", () => {
    expect(
      bundle([
        [
          "filament",
          "Support For PA/PET",
          { filament_type: ["PA"] },
          "filament/Support For PA PET.json",
        ],
      ]).flatten("filament", "Support For PA/PET").filament_type,
    ).toEqual(["PA"]);
  });
  it("does not inherit setting ids", () => {
    expect(
      bundle([
        ["machine", "parent", { setting_id: "GM001" }],
        ["machine", "child", { inherits: "parent" }],
      ]).flatten("machine", "child"),
    ).not.toHaveProperty("setting_id");
  });
  it("does not take filament ids from includes", () => {
    expect(
      bundle([
        ["filament", "template", { filament_id: "wrong" }],
        ["filament", "child", { include: ["template"] }],
      ]).flatten("filament", "child"),
    ).not.toHaveProperty("filament_id");
  });
  it("rejects missing parents", () => {
    expect(() =>
      bundle([["process", "child", { inherits: "gone" }]]).flatten("process", "child"),
    ).toThrow("gone");
  });
  it("rejects inheritance cycles", () => {
    expect(() =>
      bundle([
        ["process", "a", { inherits: "b" }],
        ["process", "b", { inherits: "a" }],
      ]).flatten("process", "a"),
    ).toThrow("loops");
  });
  it("rejects include cycles", () => {
    expect(() => bundle([["process", "a", { include: ["a"] }]]).flatten("process", "a")).toThrow(
      "loops",
    );
  });
  it("rejects paths outside bundle", () => {
    expect(() => bundle([["process", "x", {}, "../../secret.json"]]).raw("process", "x")).toThrow(
      "outside",
    );
  });
  it("rejects missing indexes", () => {
    expect(
      () =>
        new ProfileLibrary("/missing", {
          read: () => {
            throw new Error("missing");
          },
          realpath: (p) => p,
        }),
    ).toThrow("BBL.json");
  });
});
