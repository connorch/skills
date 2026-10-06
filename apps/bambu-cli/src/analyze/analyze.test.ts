import { describe, expect, it, vi } from "vite-plus/test";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { Command } from "commander";
import { Config } from "../config.ts";
import { box, lyingCup, missingTriangle, sheets, wedge } from "../mesh/test-shapes.ts";
import { memoryIO } from "../mesh/test-io.ts";
import { bounds } from "../mesh/geometry.ts";
import { load, save } from "../mesh/load.ts";
import { analyzeFile, formatReport, register } from "./index.ts";
function source(mesh = box(), format = "stl") {
  const { io, files } = memoryIO(),
    path = `/part.${format}`;
  save(path, mesh, io);
  return { io, files, path };
}
describe("upstream analyze command contract", () => {
  it("reports schema, strict JSON, seven checks and P1S default", () => {
    const { io, path } = source(sheets()),
      doc = analyzeFile(path, {}, undefined, io);
    expect(JSON.parse(JSON.stringify(doc)).schema).toBe(1);
    expect(doc.output_file).toBe(path);
    expect(doc.checks).toHaveLength(7);
    expect(doc.printer).toBe("P1S");
    expect(formatReport(doc).split("\n").at(-1)).toBe(`➡️ Use this file: ${path}`);
  });
  it("keeps 4mm and 8mm cubes small, converts tiny coordinates", () => {
    for (const size of [4, 8]) {
      const { io, path } = source(box(size)),
        doc = analyzeFile(path, { orient: true }, undefined, io);
      expect(doc.geometry.dimensions_mm).toEqual([size, size, size]);
      expect(doc.units.source).toBe("assumed");
      expect(doc.written_files).toEqual([]);
      expect(doc.notes.some((n) => n.includes("--unit"))).toBe(true);
    }
    const { io, path } = source(box(0.04, 0.02, 0.03)),
      doc = analyzeFile(path, {}, undefined, io);
    expect(doc.geometry.dimensions_mm).toEqual([40, 20, 30]);
    expect(doc.output_file).toBe("/part_scaled.stl");
  });
  it("repairs a missing triangle by default and respects no-auto-repair", () => {
    const { io, path } = source(missingTriangle()),
      doc = analyzeFile(path, {}, undefined, io);
    expect(doc.steps.repair).toMatchObject({ applied: true, before: { boundary_edges: 3 } });
    expect(doc.mesh.watertight).toBe(true);
    expect(doc.output_file).toBe("/part_repaired.stl");
    const untouched = analyzeFile(path, { autoRepair: false }, undefined, io);
    expect(untouched.steps.repair).toMatchObject({ applied: false });
    expect(untouched.mesh.boundary_edges).toBe(3);
    expect(untouched.score).toBeLessThanOrEqual(4);
  });
  it.each(["glb", "3mf", "obj", "stl"])("chains scaling and orientation in %s", (format) => {
    const { io, path } = source(lyingCup(), format),
      doc = analyzeFile(path, { height: 60, orient: true }, undefined, io);
    expect(doc.written_files).toEqual([
      `/part_scaled.${format}`,
      `/part_scaled_oriented.${format}`,
    ]);
    expect(doc.geometry.dimensions_mm[2]).toBeCloseTo(135);
    expect(doc.notes.some((n) => n.includes("--height 60 was applied before --orient"))).toBe(true);
    expect(bounds(load(doc.output_file, io)).extents[2]).toBeCloseTo(135);
  });
  it("honours explicit units and height while preserving 3MF output", () => {
    const { io, path } = source(box(1, 2, 3), "3mf"),
      doc = analyzeFile(path, { unit: "in" }, undefined, io);
    expect(doc.units).toMatchObject({ unit: "in", scale: 25.4, source: "flag" });
    expect(doc.geometry.dimensions_mm).toEqual([25.4, 50.8, 76.2]);
    expect(bounds(load(doc.output_file, io)).extents[2]).toBeCloseTo(76.2);
    expect(analyzeFile(path, { height: 30 }, undefined, io).geometry.dimensions_mm).toEqual([
      10, 20, 30,
    ]);
  });
  it("uses configured model, explicit printer and material fallback", () => {
    const { io, path } = source();
    expect(analyzeFile(path, {}, "A1", io).printer).toBe("A1");
    expect(analyzeFile(path, { printer: "x1 carbon" }, "A1", io).printer).toBe("X1C");
    const unknown = analyzeFile(path, {}, "X9", io);
    expect(unknown.printer).toBeNull();
    expect(unknown.checks.find((c) => c.id === "build_volume")?.status).toBe("skipped");
    expect(() => analyzeFile(path, { printer: "X9" }, undefined, io)).toThrow("Known:");
    expect(analyzeFile(path, { material: "UNOBTAINIUM" }, undefined, io)).toMatchObject({
      material: "PLA",
    });
  });
  it("rejects missing, unreadable Models and invalid heights", () => {
    const { io, files, path } = source();
    expect(() => analyzeFile("/missing.stl", {}, undefined, io)).toThrow("file not found");
    files.set(path, new TextEncoder().encode("not a mesh"));
    expect(() => analyzeFile(path, {}, undefined, io)).toThrow("could not read");
    expect(() => analyzeFile(path, { height: -1 }, undefined, io)).toThrow("positive");
  });
  it("applies the 45-degree rule through the full report", () => {
    const { io, path } = source(wedge(42)),
      doc = analyzeFile(path, {}, undefined, io);
    expect(doc.checks.find((c) => c.id === "overhangs")).toMatchObject({
      area_pct: 0,
      status: "pass",
      limit_deg: 45,
    });
  });
  it("registers all required flags and emits a JSON usage error", async () => {
    const program = new Command(),
      config = new Config({
        env: {},
        dir: "/nonexistent",
        keychain: { read: () => undefined, write: () => {}, remove: () => {} },
      });
    register(program, config);
    const help = program.commands[0]!.helpInformation();
    for (const flag of [
      "--height",
      "--orient",
      "--repair",
      "--material",
      "--printer",
      "--json",
      "--purpose",
      "--unit",
      "--keep-main",
      "--no-auto-repair",
    ])
      expect(help).toContain(flag);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {}),
      stderr = vi.spyOn(console, "error").mockImplementation(() => {}),
      previous = process.exitCode;
    try {
      await program.parseAsync(["analyze", "/nonexistent/model.stl", "--json"], { from: "user" });
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(stdout.mock.calls[0]![0])).error.type).toBe("usage");
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = previous;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
describe("remaining upstream file and argument regressions", () => {
  it("reads declared inches in 3MF and saves converted millimetres", () => {
    const { io, files, path } = source(box(1, 2, 3), "3mf"),
      archive = unzipSync(io.read(path));
    archive["3D/3dmodel.model"] = strToU8(
      strFromU8(archive["3D/3dmodel.model"]!).replace('unit="millimeter"', 'unit="inch"'),
    );
    files.set(path, zipSync(archive));
    const doc = analyzeFile(path, {}, undefined, io);
    expect(doc.units).toMatchObject({ unit: "in", scale: 25.4, source: "file" });
    expect(doc.geometry.dimensions_mm).toEqual([25.4, 50.8, 76.2]);
    expect(load(doc.output_file, io).unit).toBe("millimeter");
  });
  it("loads PLY and writes its scaled Model as STL", () => {
    const { io, files } = memoryIO(),
      path = "/part.ply";
    files.set(
      path,
      strToU8(
        "ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 4\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n10 0 0\n0 10 0\n0 0 10\n3 0 2 1\n3 0 1 3\n3 0 3 2\n3 1 2 3\n",
      ),
    );
    const doc = analyzeFile(path, { height: 20 }, undefined, io);
    expect(doc.output_file).toBe("/part_scaled.stl");
    expect(doc.geometry.dimensions_mm).toEqual([20, 20, 20]);
  });
  it("JSON success prints only one stdout document", async () => {
    const { io, path } = source(),
      program = new Command(),
      config = new Config({
        dir: "/nonexistent",
        env: {},
        keychain: { read: () => undefined, write: () => {}, remove: () => {} },
      });
    register(program, config, io);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {}),
      stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await program.parseAsync(["analyze", path, "--json", "--height", "60"], { from: "user" });
      expect(stdout).toHaveBeenCalledTimes(1);
      const doc = JSON.parse(String(stdout.mock.calls[0]![0]));
      expect(doc.geometry.dimensions_mm).toEqual([60, 60, 60]);
      expect(stderr).toHaveBeenCalledWith("➡️ Use this file: /part_scaled.stl");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
  it.each(["--render", "--no-clean", "--no-simplify", "--output-dir=x"])(
    "explains removed %s and exits 2",
    async (flag) => {
      const { io, path } = source(),
        program = new Command(),
        config = new Config({
          dir: "/nonexistent",
          env: {},
          keychain: { read: () => undefined, write: () => {}, remove: () => {} },
        });
      register(program, config, io);
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {}),
        stderr = vi.spyOn(console, "error").mockImplementation(() => {}),
        previous = process.exitCode;
      try {
        await program.parseAsync(["analyze", path, flag, "--json"], { from: "user" });
        expect(process.exitCode).toBe(2);
        expect(JSON.parse(String(stdout.mock.calls[0]![0])).error.message).toContain("was removed");
      } finally {
        process.exitCode = previous;
        stdout.mockRestore();
        stderr.mockRestore();
      }
    },
  );
});
