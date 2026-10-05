import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it, vi } from "vite-plus/test";
import { Config } from "../config.ts";
import { initializeKit, make, register, writeModel } from "./index.ts";

// Temporary directories isolate every output, with no printer or Keychain access.
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "bambu-make-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Decode STL positions independently to check the written Model, not only its summary.
function stlMeasurements(buffer: Buffer) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  const triangles = buffer.readUInt32LE(80);
  let volume = 0;
  expect(buffer.length).toBe(84 + triangles * 50);
  for (let triangle = 0; triangle < triangles; triangle++) {
    const vertices = [0, 1, 2].map((corner) =>
      [0, 1, 2].map((axis) => buffer.readFloatLE(84 + triangle * 50 + 12 + corner * 12 + axis * 4)),
    );
    const [a, b, c] = vertices;
    if (!a || !b || !c) throw new Error("Missing STL vertices");
    volume +=
      (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) +
        a[1]! * (b[2]! * c[0]! - b[0]! * c[2]!) +
        a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) /
      6;
    for (let corner = 0; corner < 3; corner++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = buffer.readFloatLE(84 + triangle * 50 + 12 + corner * 12 + axis * 4);
        min[axis] = Math.min(min[axis]!, value);
        max[axis] = Math.max(max[axis]!, value);
      }
    }
  }
  return { dimensions: max.map((value, axis) => value - min[axis]!), volume };
}

describe("Make script runner and STL", () => {
  it.each(["bracket", "plate"])("runs the %s TS example end to end", async (name) => {
    await temporary(async (directory) => {
      const script = fileURLToPath(new URL(`./examples/${name}.ts`, import.meta.url));
      const destination = join(directory, `${name}.stl`);
      const summary = await make(script, destination);
      const dimensions = name === "bracket" ? [30, 40, 40] : [60, 40, 3];
      expect(summary.dimensions).toEqual(dimensions);
      const stl = stlMeasurements(await readFile(destination));
      expect(stl.dimensions).toEqual(dimensions);
      expect(stl.volume).toBeCloseTo(summary.volume, 2);
      const expected =
        name === "bracket" ? 6930 - 2 * Math.PI * 1.6 ** 2 * 3 : 7200 - 4 * Math.PI * 1.6 ** 2 * 3;
      expect(Math.abs(summary.volume / expected - 1)).toBeLessThan(0.001);
    });
  });
  it("uses a neighbouring STL by default and imports JS modules", async () => {
    await temporary(async (directory) => {
      const script = join(directory, "model.mjs");
      await writeFile(script, "export default async kit => kit.box(30,20,10)");
      const result = await make(script);
      expect(result.output).toBe(join(directory, "model.stl"));
      expect(stlMeasurements(await readFile(result.output))).toMatchObject({
        dimensions: [30, 20, 10],
        volume: 6000,
      });
    });
  });
  it("refuses empty and non-manifold Models without overwriting files", async () => {
    await temporary(async (directory) => {
      const kit = await initializeKit();
      const destination = join(directory, "existing.stl");
      await writeFile(destination, "keep");
      const empty = kit.box(10, 10, 10).subtract(kit.box(20, 20, 20).translate([-5, -5, -5]));
      await expect(writeModel(empty, destination)).rejects.toThrow("empty");
      expect(await readFile(destination, "utf8")).toBe("keep");
      const invalid = kit.box(10, 10, 10);
      vi.spyOn(invalid, "status").mockReturnValue("NotManifold");
      await expect(writeModel(invalid, destination)).rejects.toThrow("Invalid geometry");
      expect(await readFile(destination, "utf8")).toBe("keep");
    });
  });
  it("rejects missing scripts, missing default functions and wrong return types", async () => {
    await temporary(async (directory) => {
      await expect(make(join(directory, "missing.ts"))).rejects.toThrow();
      const script = join(directory, "no-default.mjs");
      await writeFile(script, "export const value = 1");
      await expect(make(script)).rejects.toThrow("default function");
      const wrong = join(directory, "wrong.mjs");
      await writeFile(wrong, "export default () => 1");
      await expect(make(wrong)).rejects.toThrow("return a Manifold");
      await expect(make(script, script)).rejects.toThrow("differ");
      await expect(make(script, join(directory, "out.obj"))).rejects.toThrow("STL");
    });
  });
  it("registers help and writes one JSON document for multiple bodies", async () => {
    await temporary(async (directory) => {
      const script = join(directory, "bodies.mjs");
      await writeFile(
        script,
        "export default kit => kit.enclosure({width:60,depth:40,height:30,lid:true})",
      );
      const program = new Command();
      register(
        program,
        new Config({
          dir: directory,
          env: {},
          keychain: {
            read: () => undefined,
            write: () => {
              throw new Error("Unexpected Keychain access");
            },
            remove: () => {
              throw new Error("Unexpected Keychain access");
            },
          },
        }),
      );
      expect(program.commands[0]?.helpInformation()).toContain("--out");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await program.parseAsync(["make", script, "--json"], { from: "user" });
        expect(log).toHaveBeenCalledTimes(1);
        const document: unknown = JSON.parse(String(log.mock.calls[0]?.[0]));
        expect(document).toMatchObject({ bodies: 2, watertight: true, dimensions: [125, 40, 30] });
      } finally {
        log.mockRestore();
      }
    });
  });
});
