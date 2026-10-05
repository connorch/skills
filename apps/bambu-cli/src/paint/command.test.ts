import { describe, expect, it, vi } from "vite-plus/test";
import { Command } from "commander";
import { Config } from "../config.ts";
import { parseStatus, type Slot } from "../printer/report.ts";
import { defaultDependencies, formatReport, register, runPaint } from "./index.ts";
import { loadColouredModel, decodeTexture, textureSize } from "./load.ts";
import { nearestFilaments, nearestSlots } from "./filaments.ts";
import { readProject } from "./project.ts";
import { bands, box, glb, png, textured } from "./fixtures/builder.ts";
import { buildObj, vertexLabels } from "./obj.ts";
import jpeg from "jpeg-js";
const bytes = glb(
  [{ ...box([0.04, 0.04, 0.04]), material: 0 }],
  [textured(0)],
  [
    png(
      bands([
        [200, 30, 30],
        [30, 180, 40],
        [30, 60, 200],
      ]),
    ),
  ],
);
const config = new Config({
  dir: "/paint-test-config-never-written",
  env: {},
  keychain: { read: () => undefined, write: () => {}, remove: () => {} },
});
const slots: Slot[] = [
  {
    unit: 0,
    slot: 0,
    material: "PLA",
    name: "Red",
    color: "#C81E1E",
    remaining_pct: 80,
    active: false,
  },
  {
    unit: 0,
    slot: 1,
    material: "PLA",
    name: "Green",
    color: "#1EB428",
    remaining_pct: 80,
    active: false,
  },
  {
    unit: 0,
    slot: 2,
    material: "PLA",
    name: "Blue",
    color: "#1E3CC8",
    remaining_pct: 80,
    active: false,
  },
];
function dependencies(loaded: Slot[] = slots) {
  return {
    ...defaultDependencies,
    load: async () => loadColouredModel("cube.glb", async () => bytes),
    status: vi.fn(async () => ({ ...parseStatus({}), trays: loaded })),
    write: vi.fn(async () => {}),
    stderr: vi.fn(),
  };
}
describe("paint command and AMS contract", () => {
  it("uses loaded Slots by default and writes a P1S project", async () => {
    const deps = dependencies(),
      report = await runPaint("cube.glb", { height: "30" }, config, deps);
    expect(report.output_file).toMatch(/cube_painted\.3mf$/);
    expect(report.size_mm).toEqual([30, 30, 30]);
    expect(report.metric).toBe("CIEDE2000");
    expect(report.colors.every((c) => "slot" in c)).toBe(true);
    expect(deps.status).toHaveBeenCalledOnce();
    const file = deps.write.mock.calls[0];
    expect(file).toBeDefined();
    expect(formatReport(report).trim().split("\n").at(-1)).toBe(
      `➡️ Use this file: ${report.output_file}`,
    );
  });
  it("explicit colours always win and --no-ams avoids the printer", async () => {
    const deps = dependencies();
    const report = await runPaint(
      "cube.glb",
      { colors: "#c81e1e,#1EB428,#1E3CC8,#FFFFFF" },
      config,
      deps,
    );
    expect(deps.status).not.toHaveBeenCalled();
    expect(report.colors.map((c) => c.hex)).toEqual(["#C81E1E", "#1EB428", "#1E3CC8", "#FFFFFF"]);
    expect(report.colors[3]!.area_pct).toBe(0);
    await runPaint("cube.glb", { ams: false }, config, deps);
    expect(deps.status).not.toHaveBeenCalled();
  });
  it("falls back when no loaded Slot has a colour or the printer is unreachable", async () => {
    const deps = dependencies([]),
      report = await runPaint("cube.glb", {}, config, deps);
    expect(report.colors.every((c) => "suggested_filament" in c && c.suggested_filament)).toBe(
      true,
    );
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("no loaded PLA Slot"));
    deps.status.mockRejectedValueOnce(new Error("offline"));
    await runPaint("cube.glb", {}, config, deps);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("printer unreachable"));
  });
  it("ignores Slots of other materials, since the project is written for PLA", async () => {
    const deps = dependencies([slots[0]!, { ...slots[1]!, material: "PETG" }]),
      report = await runPaint("cube.glb", {}, config, deps);
    expect(
      report.colors.flatMap((c) => ("slot" in c && c.slot ? [c.slot.name] : [])),
    ).not.toContain("Green");
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining("only PLA Slots"));
  });
  it("refuses to overwrite the input Model or write a non-3MF", async () => {
    const deps = dependencies();
    await expect(runPaint("cube.glb", { output: "cube.glb" }, config, deps)).rejects.toThrow(
      "must not be the input",
    );
    await expect(runPaint("cube.glb", { output: "out.stl" }, config, deps)).rejects.toThrow(".3mf");
  });
  it("maps every cluster to the nearest Slot and caps Palette size", async () => {
    const deps = dependencies([
        { ...slots[0]!, color: "#FF0000" },
        { ...slots[2]!, color: "#0000FF" },
      ]),
      report = await runPaint("cube.glb", { maxColors: "1" }, config, deps);
    expect(report.colors).toHaveLength(1);
    const colour = report.colors[0]!;
    expect("slot" in colour ? colour.slot.hex : undefined).toBe(colour.hex);
    const nearest = nearestSlots(["#C81E1E"], slots);
    expect(nearest[0]!.slot.label).toBe("A1");
    expect(nearest[0]!.delta_e).toBe(0);
  });
  it.each([
    { maxColors: "9" },
    { maxColors: "0" },
    { maxColors: "1.5" },
    { minArea: "5" },
    { height: "-3" },
    { colors: "#12345" },
    { colors: Array<string>(9).fill("#000000").join(",") },
    { smooth: "-1" },
    { smooth: "NaN" },
    { finish: "nope" },
    { minArea: "0.1", minPct: "1" },
  ])("rejects bad arguments %j before reading the printer", async (options) => {
    const deps = dependencies();
    await expect(runPaint("cube.glb", options, config, deps)).rejects.toBeInstanceOf(RangeError);
    expect(deps.status).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });
  it("supports --min-pct and writes one JSON document through commander", async () => {
    const deps = dependencies(),
      stdout = vi.spyOn(console, "log").mockImplementation(() => {}),
      stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const program = new Command();
      register(program, config, deps);
      await program.parseAsync(["paint", "cube.glb", "--no-ams", "--min-pct", "1", "--json"], {
        from: "user",
      });
      expect(stdout).toHaveBeenCalledOnce();
      const doc = JSON.parse(String(stdout.mock.calls[0]![0])) as { metric: string };
      expect(doc.metric).toBe("CIEDE2000");
      expect(deps.status).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
  it("round trips the command project and reports JSON errors", async () => {
    const sink: Uint8Array[] = [];
    const deps = {
      ...dependencies(),
      write: async (_path: string, data: Uint8Array | string) => {
        if (typeof data !== "string") sink.push(data);
      },
    };
    const report = await runPaint("cube.glb", { ams: false }, config, deps);
    expect(readProject(sink[0]!).settings.filament_colour).toEqual(report.colors.map((c) => c.hex));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {}),
      stderr = vi.spyOn(console, "error").mockImplementation(() => {}),
      previous = process.exitCode;
    try {
      const program = new Command();
      register(program, config, deps);
      await program.parseAsync(["paint", "cube.glb", "--max-colors", "9", "--json"], {
        from: "user",
      });
      expect(process.exitCode).toBe(2);
      expect(String(stdout.mock.calls[0]![0])).toContain("bad_arguments");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = previous;
    }
  });
  it("matches catalogue colours and skips translucent filaments", () => {
    expect(
      nearestFilaments(
        ["#FF0000"],
        [
          { line: "PLA Translucent", name: "red", hex: "#FF0000" },
          { line: "PLA Basic", name: "red", hex: "#FE0000" },
        ],
      )[0]?.name,
    ).toBe("red");
    expect(nearestFilaments(["#000000"], [])).toEqual([undefined]);
  });
  it("decodes JPEG with a pure JavaScript decoder", () => {
    const image = bands([[200, 30, 30]], 8),
      encoded = jpeg.encode(image, 100).data,
      decoded = decodeTexture(encoded);
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(8);
    expect(Math.abs(decoded.data[0]! - 200)).toBeLessThan(3);
  });
  it("reads texture sizes from the header and refuses oversized ones undecoded", () => {
    const image = bands([[200, 30, 30]], 8);
    expect(textureSize(png(image))).toEqual([8, 8]);
    expect(textureSize(jpeg.encode(image, 100).data)).toEqual([8, 8]);
    const huge = Buffer.from(png(image));
    huge.writeUInt32BE(20000, 16);
    huge.writeUInt32BE(20000, 20);
    expect(() => decodeTexture(huge)).toThrow("20000 x 20000");
  });
  it("reads textured and vertex-colour OBJ with injected files", async () => {
    const files = new Map([
      [
        "/cube.obj",
        Buffer.from(
          "mtllib cube.mtl\nusemtl red\nv 0 0 0\nv 10 0 0\nv 0 10 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n",
        ),
      ],
      ["/cube.mtl", Buffer.from("newmtl red\nKd 1 0 0\nmap_Kd -s 1 1 1 -clamp on red.png\n")],
      ["/red.png", png(bands([[200, 30, 30]], 8))],
    ]);
    const model = await loadColouredModel("/cube.obj", async (p) => {
      const data = files.get(p);
      if (!data) throw new Error(p);
      return data;
    });
    expect(model.parts[0]!.texture?.width).toBe(8);
    expect(model.turned).toBe(true);
    model.vertices[2]!.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 10][i]!));
    const vertex = await loadColouredModel("/vertex.obj", async () =>
      Buffer.from("v 0 0 0 1 0 0\nv 1 0 0 1 0 0\nv 0 1 0 1 0 0\nf 1 2 3\n"),
    );
    expect(vertex.vertexColours[0]).toEqual([1, 0, 0, 1]);
  });
  it("exports OBJ vertex labels by incident triangle majority", () => {
    const cube = box([40, 40, 40]),
      labels = cube.faces.map((_, i) => i % 2),
      text = buildObj(cube.positions, cube.faces, labels, [
        [1, 0, 0],
        [0, 0, 1],
      ]);
    expect(text.split("\n").filter((l) => l.startsWith("v "))).toHaveLength(8);
    expect(
      vertexLabels(
        4,
        [
          [0, 1, 2],
          [0, 2, 3],
        ],
        [0, 1],
        2,
      ),
    ).toEqual([0, 0, 0, 1]);
  });
});
