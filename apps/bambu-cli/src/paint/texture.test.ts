import { describe, expect, it } from "vite-plus/test";
import { loadColouredModel, NoColourError } from "./load.ts";
import { paintModel } from "./pipeline.ts";
import { standUpright } from "../generate/download.ts";
import { sampleSurface, texelIndex } from "./sampling.ts";
import {
  bands,
  box,
  glb,
  grid,
  png,
  sphere,
  textured,
  RED,
  GREEN,
  BLUE,
} from "./fixtures/builder.ts";
import type { Vec3, Vec4 } from "./lab.ts";
const load = (bytes: Uint8Array) => loadColouredModel("model.glb", async () => bytes);
const paint = async (bytes: Uint8Array) => paintModel(await load(bytes));
const plate = (image: ReturnType<typeof bands>, cells = 12) =>
  glb([{ ...grid(cells, 0.03), material: 0 }], [textured(0)], [png(image)]);
describe("upstream colour texture cases", () => {
  it("uses the base-colour image when a normal map comes first", async () => {
    const material = { ...textured(1), normalTexture: { index: 0 } };
    const result = await paint(
      glb(
        [{ ...box([0.02, 0.02, 0.02]), material: 0 }],
        [material],
        [png(bands([[128, 128, 255]])), png(bands([RED, BLUE]))],
      ),
    );
    expect(result.palette.hex.sort()).toEqual(["#1E3CC8", "#C81E1E"]);
  });
  it("samples UV 1 at the far edge, repeats outside and keeps rows in glTF order", async () => {
    expect([0, 1, -0.1, 1.1].map((v) => texelIndex(v, 10))).toEqual([0, 9, 9, 1]);
    const cube = await load(
      glb(
        [{ ...box([0.04, 0.04, 0.04]), material: 0 }],
        [textured(0)],
        [png(bands([RED, GREEN, BLUE]))],
      ),
    );
    const samples = sampleSurface(cube);
    cube.faces.forEach((f, i) => {
      if (f.every((v) => cube.uv[v]![0] === 1)) {
        samples.face.forEach((id, j) => {
          if (id === i) expect(samples.rgb[j]!.map((v) => Math.round(v * 255))).toEqual(BLUE);
        });
      }
    });
    const image = bands([RED]);
    for (let y = 32; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        image.data[i] = BLUE[0];
        image.data[i + 1] = BLUE[1];
        image.data[i + 2] = BLUE[2];
      }
    const mesh = grid(2, 0.01),
      model = await load(plate(image, 2)),
      s = sampleSurface(model);
    expect(
      s.rgb.filter((_, i) => s.face[i] === 0).every((c) => Math.round(c[0] * 255) === RED[0]),
    ).toBe(true);
    expect(model.vertices.length).toBe(mesh.positions.length);
  });
  it.each(["OPAQUE", "BLEND", "MASK"] as const)(
    "ignores transparent texels in %s",
    async (alphaMode) => {
      const result = await paint(
        glb(
          [{ ...grid(12, 0.03), material: 0 }],
          [textured(0, undefined, alphaMode)],
          [png(bands([RED, GREEN, BLUE], 64, [255, 255, 0]))],
        ),
      );
      expect(result.palette.hex.sort()).toEqual(["#1EB428", "#C81E1E"]);
      expect(result.areaShare.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    },
  );
  it("ignores junk alpha when the whole texture is transparent", async () => {
    const result = await paint(plate(bands([RED, BLUE], 64, [0, 0]), 6));
    expect(result.palette.hex.sort()).toEqual(["#1E3CC8", "#C81E1E"]);
    expect(result.warnings.join()).toContain("alpha channel is ignored");
  });
  it("never counts atlas padding", async () => {
    const image = bands([[0, 0, 0]]);
    for (let y = 0; y < 64; y++)
      for (let x = 40; x < 64; x++) {
        const c = y < 32 ? RED : GREEN,
          i = (y * 64 + x) * 4;
        image.data[i] = c[0];
        image.data[i + 1] = c[1];
        image.data[i + 2] = c[2];
      }
    const mesh = grid(10, 0.03);
    mesh.uv = mesh.uv.map(([u, v]) => [0.65 + u * 0.3, v]);
    const result = await paint(glb([{ ...mesh, material: 0 }], [textured(0)], [png(image)]));
    expect(result.palette.hex.sort()).toEqual(["#1EB428", "#C81E1E"]);
  });
  it("preserves mid greys", async () =>
    expect(
      (
        await paint(
          plate(
            bands([
              [51, 51, 51],
              [123, 123, 123],
              [240, 240, 240],
            ]),
          ),
        )
      ).palette.hex.sort(),
    ).toEqual(["#333333", "#7B7B7B", "#F0F0F0"]));
  it("tints the texture in linear light", async () => {
    const result = await paint(
      glb(
        [{ ...grid(4, 0.02), material: 0 }],
        [textured(0, [0.5, 0.5, 0.5, 1])],
        [png(bands([[255, 255, 255]], 8))],
      ),
    );
    expect(result.palette.hex).toEqual(["#BCBCBC"]);
    expect(result.warnings.join()).toContain("only one colour");
  });
  it("uses untextured material colours", async () => {
    const cube = box([0.02, 0.02, 0.02]),
      other = { ...cube, positions: cube.positions.map(([x, y, z]): Vec3 => [x + 0.03, y, z]) };
    const result = await paint(
      glb(
        [
          { ...cube, material: 0 },
          { ...other, material: 1 },
        ],
        [
          { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
          { pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } },
        ],
      ),
    );
    expect(result.palette.hex.sort()).toEqual(["#0000FF", "#FF0000"]);
    result.areaShare.forEach((v) => expect(v).toBeCloseTo(0.5));
  });
  it("decodes glTF vertex colours from linear light", async () => {
    const mesh = grid(8, 0.02),
      colors = mesh.positions.map((p): Vec4 =>
        p[0] < 0.0099 ? [0.21404, 0.21404, 0.21404, 1] : [1, 0, 0, 1],
      );
    expect((await paint(glb([{ ...mesh, colors }]))).palette.hex.sort()).toEqual([
      "#808080",
      "#FF0000",
    ]);
  });
  it("converts axes, millimetres, transforms and requested height", async () => {
    const mesh = { ...box([0.01, 0.06, 0.02]), material: 0 },
      materials = [textured(0)],
      images = [png(bands([RED, BLUE]))];
    const normal = await paint(glb([mesh], materials, images));
    normal.sizeMm.forEach((v, i) => expect(v).toBeCloseTo([10, 20, 60][i]!));
    const doubled = await paint(
      glb([mesh], materials, images, [[2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]]),
    );
    doubled.sizeMm.forEach((v, i) => expect(v).toBeCloseTo([20, 40, 120][i]!));
    const sized = paintModel(await load(glb([mesh], materials, images)), { height: 45 });
    sized.sizeMm.forEach((v, i) => expect(v).toBeCloseTo([7.5, 15, 45][i]!));
  });
  it("welds UV seams and poles on a sphere", async () => {
    const mesh = sphere(),
      image = bands([RED]);
    for (let y = 32; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        image.data[i] = BLUE[0];
        image.data[i + 1] = BLUE[1];
        image.data[i + 2] = BLUE[2];
      }
    const result = await paint(glb([{ ...mesh, material: 0 }], [textured(0)], [png(image)]));
    expect(result.palette.hex.sort()).toEqual(["#1E3CC8", "#C81E1E"]);
    expect(result.vertices.length).toBeLessThan(mesh.positions.length);
    const red = result.palette.hex.indexOf("#C81E1E"),
      north = result.faces
        .map((f, i) => ({ i, z: f.reduce((s, v) => s + result.vertices[v]![2], 0) / 3 }))
        .filter((f) => f.z > 0);
    expect(north.filter((f) => result.labels[f.i] === red).length / north.length).toBeGreaterThan(
      0.95,
    );
  });
  it("does not turn a generated GLB a second time", async () => {
    const tall = { ...box([0.01, 0.01, 0.03]), material: 0 },
      image = png(bands([RED, GREEN, BLUE]));
    // A raw glTF is Y-up: its tall axis lands on Z.
    const raw = await load(glb([tall], [textured(0)], [image]));
    // After generate's upright node the file is Z-up already.
    const upright = await load(standUpright(Buffer.from(glb([tall], [textured(0)], [image]))));
    const extent = (vs: Vec3[], k: number) =>
      Math.max(...vs.map((v) => v[k]!)) - Math.min(...vs.map((v) => v[k]!));
    expect(extent(raw.vertices, 2)).toBeCloseTo(10, 3);
    expect(extent(upright.vertices, 2)).toBeCloseTo(10, 3);
  });
  it("refuses colourless, unsupported, missing and malformed Models", async () => {
    await expect(load(glb([box()]))).rejects.toBeInstanceOf(NoColourError);
    await expect(loadColouredModel("model.stl")).rejects.toThrow("unsupported format");
    await expect(loadColouredModel("/missing.glb")).rejects.toThrow("not found");
    await expect(load(Buffer.from("glTF not really"))).rejects.toThrow("could not read");
  });
});
