import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";
import { ProfileLibrary } from "./profiles.ts";
import {
  buildCommand,
  checkOutput,
  PLATES,
  runSlice,
  spawnSlicer,
  validatePlate,
  type SliceJob,
  type ProcessInvocation,
  type ProcessResult,
} from "./runner.ts";
const library = new ProfileLibrary(fileURLToPath(new URL("./fixtures/profiles", import.meta.url)));
const header = readFileSync(new URL("./fixtures/plate_1_header.gcode", import.meta.url), "utf8");
const resultText = readFileSync(new URL("./fixtures/result_p1s_box.json", import.meta.url), "utf8");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});
function job(): SliceJob {
  const root = mkdtempSync(join(tmpdir(), "slice-test-"));
  dirs.push(root);
  const model = join(root, "cube.stl");
  writeFileSync(model, "solid cube\nendsolid cube");
  return {
    model,
    output: join(root, "out", "cube_sliced.3mf"),
    machine: library.flatten("machine", "Bambu Lab P1S 0.4 nozzle"),
    process: library.flatten("process", "0.20mm Standard @BBL X1C"),
    filament: library.flatten("filament", "Bambu PLA Basic @BBL P1S 0.4 nozzle"),
    plate: "textured",
    timeout_s: 20,
  };
}
function fake(mode = "ok", capture?: (i: ProcessInvocation) => void) {
  return (invocation: ProcessInvocation): ProcessResult => {
    capture?.(invocation);
    writeFileSync(invocation.logPath, "[info] test\n[error] canned slicer error\n");
    if (mode === "timeout") return { status: null, timedOut: true };
    if (mode === "missing_exe") return { status: null, error: new Error("ENOENT") };
    if (mode === "fail") {
      writeFileSync(
        join(invocation.cwd, "result.json"),
        JSON.stringify({
          return_code: -61,
          error_string: "Filaments are not compatible with the plate type.",
        }),
      );
      return { status: 1 };
    }
    const suffix =
      mode === "no_load"
        ? "M620 S255\nM190 S55\n"
        : mode === "bad_temp"
          ? "M620 S0A\nM190 S0\n"
          : "M620 S0A\nM190 S55\n";
    const gcode = header + "\n" + suffix;
    const report =
      mode === "zero"
        ? resultText.replace('"total_used_g": 5.082495212554932', '"total_used_g": 0')
        : resultText;
    if (mode !== "no_result") writeFileSync(join(invocation.cwd, "result.json"), report);
    writeFileSync(join(invocation.cwd, "plate_1.gcode"), gcode);
    if (mode !== "no_3mf")
      writeFileSync(
        join(invocation.cwd, "sliced.3mf"),
        zipSync({
          "Metadata/plate_1.gcode": strToU8(gcode),
          "3D/3dmodel.model": strToU8("<model/>"),
        }),
      );
    return { status: 0 };
  };
}
describe("upstream runner and P1S validation", () => {
  it("real process adapter redirects logs and enforces timeout", () => {
    const j = job();
    const invocation = {
      command: process.execPath,
      args: ["-e", "console.log('canned log')"],
      cwd: dirname(j.model),
      timeoutMs: 2000,
      logPath: join(dirname(j.model), "slice.log"),
    };
    expect(spawnSlicer(invocation).status).toBe(0);
    expect(readFileSync(invocation.logPath, "utf8")).toContain("canned log");
    expect(
      spawnSlicer({ ...invocation, args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 50 })
        .timedOut,
    ).toBe(true);
  });
  it("writes validated project, reads recorded estimate, removes scratch", () => {
    const j = job();
    const result = runSlice(["/fake"], j, { spawn: fake() });
    expect(result.output_file).toBe(j.output);
    expect(existsSync(j.output)).toBe(true);
    expect(result.estimate.print_time_s).toBeCloseTo(1125.9, 1);
    expect(result.bambu_studio_version).toBe("02.07.01.62");
    expect(readdirSync(join(j.output, ".."))).toEqual(["cube_sliced.3mf"]);
    expect(result.plate_summaries[0]?.preview).toBe("Metadata/plate_1.png");
  });
  it("runs exact upstream args in scratch and passes flattened profiles unchanged", () => {
    const j = job();
    runSlice(["/fake"], j, {
      spawn: fake("ok", (i) => {
        expect([i.command, ...i.args]).toEqual(buildCommand(["/fake"], i.cwd, j.model));
        expect(i.args[i.args.indexOf("--export-3mf") + 1]).toBe("sliced.3mf");
        expect(i.args[i.args.indexOf("--outputdir") + 1]).toBe(i.cwd);
        expect(i.timeoutMs).toBe(20000);
        expect(JSON.parse(readFileSync(join(i.cwd, "machine.json"), "utf8"))).toEqual(j.machine);
        expect(JSON.parse(readFileSync(join(i.cwd, "filament.json"), "utf8"))).toEqual(j.filament);
        expect(JSON.parse(readFileSync(join(i.cwd, "process.json"), "utf8"))).toEqual({
          ...j.process,
          curr_bed_type: "Textured PEI Plate",
        });
      }),
    });
  });
  it("missing result falls back to archived header with safety checks", () => {
    expect(runSlice(["/fake"], job(), { spawn: fake("no_result") }).estimate).toMatchObject({
      source: "gcode",
      print_time_s: 1125,
      filament_g: 5.08,
    });
  });
  it.each([
    ["fail", "not compatible with the plate type. (code -61)"],
    ["no_3mf", "without writing a sliced 3MF"],
    ["timeout", "did not finish within 20 s"],
    ["missing_exe", "could not run"],
    ["zero", "uses 0 g"],
    ["no_load", "never loads filament"],
    ["bad_temp", "heats the bed to 0C"],
  ])("refuses %s and preserves log", (mode, message) => {
    const j = job();
    expect(() => runSlice(["/fake"], j, { spawn: fake(mode) })).toThrow(message);
    expect(existsSync(j.output)).toBe(false);
    const scratch = readdirSync(join(j.output, ".."))[0];
    expect(scratch).toMatch(/^\.bambu-slice-/);
    expect(existsSync(join(j.output, "..", scratch ?? "", "slice.log"))).toBe(true);
  });
  it("reports last error lines without result.json", () => {
    const j = job();
    expect(() =>
      runSlice(["/fake"], j, {
        spawn: (i) => {
          writeFileSync(i.logPath, "[error] very useful failure\n");
          return { status: 1 };
        },
      }),
    ).toThrow("very useful failure");
  });
  it("rejects an output alias of the input", () => {
    const j = job();
    const alias = join(dirname(j.model), "alias.3mf");
    symlinkSync(j.model, alias);
    expect(() => checkOutput(j.model, alias)).toThrow("not the input");
  });
  it("rejects hard links to input", () => {
    const j = job();
    const alias = join(dirname(j.model), "hard.3mf");
    linkSync(j.model, alias);
    expect(() => checkOutput(j.model, alias)).toThrow("not the input");
  });
  it.each(Object.keys(PLATES))("validates selected Plate %s", (key) => {
    const parsed = Object.entries(PLATES).find(([name]) => name === key);
    if (!parsed) throw new Error("missing");
    for (const plate of ["textured", "cool", "engineering", "high-temp"] as const)
      if (plate === key)
        expect(
          validatePlate(1, "M620 S0A\nM190 S70\n", 1, { [PLATES[plate].tempKey]: ["70"] }, plate)
            .bed_temp_c,
        ).toBe(70);
  });
  it("rejects missing bed temperature and S255-only loads", () => {
    expect(() =>
      validatePlate(1, "M620 S0A\n", 1, { textured_plate_temp_initial_layer: ["55"] }, "textured"),
    ).toThrow("heats the bed");
    expect(() =>
      validatePlate(
        1,
        "M620 S255\nM190 S55\n",
        1,
        { textured_plate_temp_initial_layer: ["55"] },
        "textured",
      ),
    ).toThrow("never loads");
    expect(
      validatePlate(
        1,
        "M620 S255\nM620 S0A\nM190 S55\n",
        1,
        { textured_plate_temp_initial_layer: ["55"] },
        "textured",
      ).filament_g,
    ).toBe(1);
  });
  it("checks every plate before publishing", () => {
    const j = job();
    expect(() =>
      runSlice(["/fake"], j, {
        spawn: (i) => {
          fake()(i);
          const valid = header + "\nM620 S0A\nM190 S55\n",
            bad = header + "\nM620 S255\nM190 S55\n";
          writeFileSync(
            join(i.cwd, "sliced.3mf"),
            zipSync({
              "Metadata/plate_1.gcode": strToU8(valid),
              "Metadata/plate_2.gcode": strToU8(bad),
            }),
          );
          rmSync(join(i.cwd, "result.json"));
          return { status: 0 };
        },
      }),
    ).toThrow("plate 2 never loads");
    expect(existsSync(j.output)).toBe(false);
  });
  it("validates archived G-code even if loose G-code is valid", () => {
    const j = job();
    expect(() =>
      runSlice(["/fake"], j, {
        spawn: (i) => {
          fake()(i);
          writeFileSync(
            join(i.cwd, "sliced.3mf"),
            zipSync({ "Metadata/plate_1.gcode": strToU8(header + "\nM620 S255\nM190 S55\n") }),
          );
          return { status: 0 };
        },
      }),
    ).toThrow("never loads");
  });
});
