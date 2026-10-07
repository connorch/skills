import { describe, expect, it } from "vite-plus/test";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import p1s from "./fixtures/p1s.json" with { type: "json" };
import perFilament from "./data/per_filament_keys.json" with { type: "json" };
import { buildProject, paintCode, paintFilament, projectSettings, readProject } from "./project.ts";
import { box } from "./fixtures/builder.ts";
describe("upstream Bambu project contract", () => {
  it("encodes and decodes every whole-triangle state", () => {
    const codes = ["4", "8", "0C", "1C", "2C", "3C", "4C", "5C"];
    codes.forEach((c, i) => {
      expect(paintCode(i + 1)).toBe(c);
      expect(paintFilament(c)).toBe(i + 1);
    });
    expect(paintFilament("0C0")).toBeUndefined();
    expect(paintFilament("ac")).toBeUndefined();
    expect(() => paintCode(0)).toThrow("between 1 and");
  });
  it.each([1, 2, 4, 8])("resizes every audited per-filament key for %i filaments", (count) => {
    const colours = Array.from(
        { length: count },
        (_, i) => `#${i.toString(16).padStart(2, "0").repeat(3).toUpperCase()}`,
      ),
      settings = projectSettings(colours);
    for (const key of perFilament) expect(settings[key], key).toHaveLength(count);
    expect(settings.filament_colour).toEqual(colours);
    expect(settings.filament_self_index).toEqual(colours.map((_, i) => String(i + 1)));
    expect(settings.flush_volumes_matrix).toHaveLength(count * count);
    expect(settings.flush_volumes_vector).toHaveLength(count * 2);
    expect(settings.different_settings_to_system).toHaveLength(count + 2);
    expect(settings.printer_settings_id).toBe(p1s.name);
    expect(settings.printer_model).toBe(p1s.printer_model);
    expect(settings.print_settings_id).toBe(p1s.default_print_profile);
    expect(settings.filament_settings_id).toEqual(
      Array<string>(count).fill("Bambu PLA Basic @BBL P1S 0.4 nozzle"),
    );
  });
  it("reads paint, centred placement, height and escaped object name", () => {
    const cube = box([25, 25, 25]),
      labels = cube.faces.map((_, i) => i % 3),
      colours = ["#C81E1E", "#1EB428", "#1E3CC8"];
    const data = buildProject(cube.positions, cube.faces, labels, colours, 'fox & "friends"'),
      project = readProject(data),
      archive = unzipSync(data);
    expect(project.faces).toEqual(cube.faces);
    expect(project.filaments).toEqual(labels.map((v) => v + 1));
    expect(project.settings.filament_colour).toEqual(colours);
    expect(project.buildOffset).toEqual([128, 128, 12.5]);
    const zs = project.vertices.map((v) => v[2] + project.buildOffset[2]);
    expect(Math.min(...zs)).toBe(0);
    expect(Math.max(...zs)).toBe(25);
    expect(strFromU8(archive["3D/3dmodel.model"]!)).toContain("BambuStudio-02.07");
    expect(strFromU8(archive["Metadata/model_settings.config"]!)).toContain(
      'value="fox &amp; &quot;friends&quot;"',
    );
  });
  it("reads past unrelated members and refuses a non-project archive", () => {
    const cube = box([10, 10, 10]),
      data = buildProject(
        cube.positions,
        cube.faces,
        cube.faces.map(() => 0),
        ["#000000"],
        "c",
      ),
      archive = unzipSync(data);
    const padded = zipSync({ ...archive, "Metadata/plate_1.png": new Uint8Array(1024 * 1024) });
    expect(readProject(padded).faces).toEqual(cube.faces);
    expect(() => readProject(zipSync({ "3D/3dmodel.model": strToU8("<model/>") }))).toThrow(
      "not a painted Bambu project",
    );
  });
  it("uses a configured recorded printer profile and tower fits the plate", () => {
    expect(projectSettings(["#000000"], "A1 mini").printer_settings_id).toBe(
      "Bambu Lab A1 mini 0.4 nozzle",
    );
    expect(
      Number((projectSettings(["#000000"]).wipe_tower_y as string[])[0]) + 66,
    ).toBeLessThanOrEqual(256);
  });
});
