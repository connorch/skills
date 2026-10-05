import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "../config.ts";
import {
  commandDependencies,
  formatDuration,
  listProfiles,
  millimetres,
  printSlice,
  register,
  removedOption,
} from "./index.ts";
import { ProfileLibrary } from "./profiles.ts";
import { parseResultJson } from "./estimate.ts";
import { resolveProfiles } from "./resolve.ts";
import type { SliceJob } from "./runner.ts";
const root = fileURLToPath(new URL("./fixtures/profiles", import.meta.url));
const library = new ProfileLibrary(root);
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});
function setup(modelSetting?: string) {
  const dir = mkdtempSync(join(tmpdir(), "slice-cli-"));
  dirs.push(dir);
  const model = join(dir, "cube.stl");
  writeFileSync(model, "solid cube\nendsolid cube");
  const config = new Config({
    dir,
    env: {},
    keychain: {
      read: () => {
        throw new Error("must not use Keychain");
      },
      write: () => {},
      remove: () => {},
    },
  });
  if (modelSetting) config.save({ model: modelSetting });
  const jobs: SliceJob[] = [];
  const estimate = parseResultJson({
    sliced_plates: [
      {
        total_predication: 1125.9,
        filaments: [{ id: 1, filament_id: "GFA00", total_used_g: 5.08 }],
      },
    ],
  });
  const dependencies = {
    ...commandDependencies,
    findCli: () => ["/fake"],
    findProfilesDir: () => root,
    library: () => library,
    runSlice: (_cli: string[], job: SliceJob) => {
      jobs.push(job);
      return {
        output_file: job.output,
        estimate,
        bambu_studio_version: "02.07.01.62",
        seconds: 0.4,
        plate_summaries: [
          { id: 1, filament_g: 5.08, bed_temp_c: 55, preview: "Metadata/plate_1.png" },
        ],
      };
    },
  };
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = (args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    register(program, config, dependencies);
    program.parse(["node", "bambu", "slice", ...args]);
  };
  return { model, dir, jobs, dependencies, config, out, err, run };
}
describe("upstream command contract", () => {
  it("uses configured model and explicit override", () => {
    const s = setup("P2S");
    s.run([s.model]);
    expect(s.jobs[0]?.machine.name).toBe("Bambu Lab P2S 0.4 nozzle");
    s.run([s.model, "--printer", "a1 mini"]);
    expect(s.jobs[1]?.machine.name).toBe("Bambu Lab A1 mini 0.4 nozzle");
  });
  it("unconfigured printer is usage error before Studio discovery", () => {
    const s = setup();
    s.dependencies.findCli = () => {
      throw new Error("looked for Studio");
    };
    s.run([s.model, "--json"]);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(s.out.mock.calls[0]?.[0])).error.type).toBe("not_configured");
    expect(s.err.mock.calls[0]?.[0]).toContain("No printer given and none configured");
  });
  it("JSON is one document with upstream fields and Plate summaries", () => {
    const s = setup();
    s.run([s.model, "--printer", "P1S", "--json"]);
    expect(s.out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(s.out.mock.calls[0]?.[0]))).toMatchObject({
      output_file: join(s.dir, "cube_sliced.3mf"),
      printer: "P1S",
      machine_profile: "Bambu Lab P1S 0.4 nozzle",
      process_profile: "0.20mm Standard @BBL X1C",
      filament_profiles: ["Bambu PLA Basic @BBL P1S 0.4 nozzle"],
      plate: "Textured PEI Plate",
      print_time_s: 1126,
      print_time_includes_start_sequence: true,
      filament_g: 5.08,
      filaments: [
        {
          slot: 1,
          filament_id: "GFA00",
          grams: 5.08,
          profile: "Bambu PLA Basic @BBL P1S 0.4 nozzle",
        },
      ],
      plates: 1,
      plate_summaries: [{ preview: "Metadata/plate_1.png" }],
    });
  });
  it("human output ends with estimate and next step and includes preview", () => {
    const s = setup();
    s.run([s.model, "--printer", "P1S"]);
    const lines = String(s.out.mock.calls[0]?.[0]).split("\n");
    expect(lines.at(-2)).toBe("≈ 19 min incl. start sequence · 5.1 g PLA");
    expect(lines.at(-1)).toBe(`➡️ Use this file: ${join(s.dir, "cube_sliced.3mf")}`);
    expect(lines.some((l) => l.includes("Metadata/plate_1.png"))).toBe(true);
  });
  it("passes own presets, material and Plate choice", () => {
    const s = setup();
    s.run([
      s.model,
      "--printer",
      "P1S",
      "--material",
      "PETG",
      "--plate",
      "engineering",
      "-o",
      join(s.dir, "petg.3mf"),
    ]);
    expect(s.jobs[0]).toMatchObject({
      output: join(s.dir, "petg.3mf"),
      machine: library.flatten("machine", "Bambu Lab P1S 0.4 nozzle"),
      filament: library.flatten("filament", "Generic PETG"),
      plate: "engineering",
    });
  });
  it.each([
    ["--printer", "Ender 3", "unknown_printer"],
    ["--layer-height", "0.3", "no_profile"],
    ["-o", "out.gcode", "bad_output"],
  ] as const)("argument error %s", (flag, value, kind) => {
    const s = setup("P1S");
    s.run([s.model, flag, value, "--json"]);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(s.out.mock.calls[0]?.[0])).error.type).toBe(kind);
  });
  it("rejects STEP with a way forward", () => {
    const s = setup();
    const step = join(s.dir, "model.step");
    writeFileSync(step, "ISO-10303-21;");
    s.run([step, "--printer", "P1S"]);
    expect(process.exitCode).toBe(2);
    expect(s.err.mock.calls[0]?.[0]).toContain("can't read STEP");
  });
  it("rejects missing model", () => {
    const s = setup();
    s.run([join(s.dir, "nope.stl"), "--printer", "P1S"]);
    expect(process.exitCode).toBe(2);
    expect(s.err.mock.calls[0]?.[0]).toContain("File not found");
  });
  it("missing Studio is runtime error per shared CLI conventions", () => {
    const s = setup();
    const program = new Command();
    register(program, s.config, { ...s.dependencies, findCli: () => undefined });
    program.parse(["node", "bambu", "slice", s.model, "--printer", "P1S", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(s.out.mock.calls[0]?.[0])).error.type).toBe("dependency");
  });
  it("slice failure is one JSON error", () => {
    const s = setup();
    s.dependencies.runSlice = () => {
      throw new Error("boundary of the heated bed");
    };
    s.run([s.model, "--printer", "P1S", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(s.out.mock.calls[0]?.[0])).error).toMatchObject({
      type: "slice_failed",
      message: "boundary of the heated bed",
    });
  });
  it("lists all families and compatible qualities/materials without a Model", () => {
    const s = setup();
    s.run(["--list-profiles", "--printer", "P1S", "--json"]);
    const doc = listProfiles(library, "P1S");
    expect(JSON.parse(String(s.out.mock.calls[0]?.[0]))).toEqual(doc);
    expect(doc.printers).toHaveLength(13);
    expect(doc.printers.find((p) => p.printer === "P1S")?.nozzles_mm).toEqual([0.4, 0.8]);
    expect(doc.printers.find((p) => p.printer === "X2D")?.nozzles_mm).toEqual([]);
    expect(doc.selected?.qualities).toEqual({
      draft: "0.24mm Draft @BBL X1C",
      standard: "0.20mm Standard @BBL X1C",
      fine: "0.12mm Fine @BBL X1C",
    });
    expect(doc.selected?.materials).toContain("PETG");
  });
  it("allows unconfigured listing", () => {
    const s = setup();
    s.run(["--list-profiles", "--json"]);
    expect(JSON.parse(String(s.out.mock.calls[0]?.[0])).selected).toBeNull();
  });
  it("quality and layer height conflict", () => {
    const s = setup();
    expect(() => s.run([s.model, "--quality", "fine", "--layer-height", "0.12"])).toThrow(
      "cannot be used",
    );
  });
  it.each([
    ["--filament=Bambu PLA Basic", "renamed to `--material`"],
    ["--orient", "no longer re-orients"],
    ["--arrange", "no longer arranges"],
    ["--no-detect", "no longer asks the printer"],
    ["--quality=Extra", "--layer-height 0.08"],
  ] as const)("explains removed option %s", (arg, message) => {
    expect(removedOption([arg])).toContain(message);
    const s = setup();
    if (arg.startsWith("--quality")) expect(() => s.run([s.model, arg])).toThrow(message);
    else {
      expect(() => s.run([s.model, arg])).not.toThrow();
      expect(s.err.mock.calls[0]?.[0]).toContain(message);
    }
  });
  it("duration and mm parsing", () => {
    expect(formatDuration(4320)).toBe("1 h 12 min");
    expect(millimetres("0.4mm")).toBe(0.4);
    expect(() => millimetres("NaN")).toThrow();
    expect(() => millimetres("0")).toThrow();
  });
  it("human format is reusable", () => {
    const s = setup();
    const choice = resolveProfiles(library, { printer: "P1S" });
    s.run([s.model, "--printer", "P1S"]);
    const job = s.jobs[0];
    if (!job) throw new Error("missing");
    expect(printSlice(choice, s.dependencies.runSlice(["/fake"], job))).toContain(
      "incl. start sequence",
    );
  });
});
