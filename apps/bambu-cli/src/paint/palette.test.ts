import { describe, expect, it } from "vite-plus/test";
import { loadColouredModel } from "./load.ts";
import { ColorsLostError, paintModel } from "./pipeline.ts";
import { deltaE2000, srgbToLab, type Vec3 } from "./lab.ts";
import { faceAdjacency, fillUnlabelled, smooth, weld } from "./segment.ts";
import { bands, glb, grid, png, textured } from "./fixtures/builder.ts";
const paint = async (image: ReturnType<typeof bands>, cells = 100, options = {}) =>
  paintModel(
    await loadColouredModel("plate.glb", async () =>
      glb([{ ...grid(cells, 0.05), material: 0 }], [textured(0)], [png(image)]),
    ),
    options,
  );
function faceWithEye(size = 512) {
  const image = bands([[235, 205, 60]], size),
    radius = Math.sqrt(0.003 / Math.PI) * size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const ramp = y / (size - 1);
      let c: Vec3 = [
        235 * (1 - ramp) + 215 * ramp,
        205 * (1 - ramp) + 180 * ramp,
        60 * (1 - ramp) + 35 * ramp,
      ];
      if (x < Math.floor(0.3 * size)) c = [110, 60, 25];
      if ((y - 0.4 * size) ** 2 + (x - 0.7 * size) ** 2 <= radius ** 2) c = [15, 15, 15];
      const i = (y * size + x) * 4;
      image.data[i] = Math.trunc(c[0]);
      image.data[i + 1] = Math.trunc(c[1]);
      image.data[i + 2] = Math.trunc(c[2]);
    }
  return image;
}
describe("upstream Palette and segmentation", () => {
  it("the yellow ramp prints as one colour", () =>
    expect(
      deltaE2000(
        srgbToLab([235 / 255, 205 / 255, 60 / 255]),
        srgbToLab([215 / 255, 180 / 255, 35 / 255]),
      ),
    ).toBeLessThan(12));
  it("keeps the small distinct eye", async () => {
    const result = await paint(faceWithEye());
    expect(result.palette.rgb).toHaveLength(3);
    const eye = result.palette.lab.findIndex((c) => c[0] < 15);
    expect(eye).toBeGreaterThanOrEqual(0);
    expect(Math.abs(result.areaShare[eye]! - 0.003)).toBeLessThan(0.0015);
  });
  it("merges features below minimum area", async () => {
    const result = await paint(faceWithEye(), 100, { minArea: 0.01 });
    expect(result.palette.rgb).toHaveLength(2);
    expect(result.palette.lab.every((c) => c[0] > 15)).toBe(true);
  });
  it("caps the Palette and chooses a dominant colour rather than an absorbed blend", async () => {
    const six: Vec3[] = [
        [230, 30, 30],
        [30, 160, 40],
        [30, 60, 200],
        [240, 220, 40],
        [20, 20, 20],
        [240, 240, 240],
      ],
      result = await paint(bands(six, 120), 60, { maxColors: 4 });
    expect(result.palette.rgb).toHaveLength(4);
    expect(result.areaShare.every((v) => v > 0)).toBe(true);
    expect(result.areaShare.reduce((s, v) => s + v, 0)).toBeCloseTo(1);
    result.palette.lab.forEach((c) =>
      expect(
        Math.min(...six.map((v) => deltaE2000(c, srgbToLab(v.map((n) => n / 255) as Vec3)))),
      ).toBeLessThan(2),
    );
  });
  it("preserves forced order and warns on unused colours", async () => {
    const result = await paint(
      bands([
        [200, 30, 30],
        [30, 60, 200],
      ]),
      20,
      { colors: ["#FFFFFF", "#1E3CC8", "#C81E1E"] },
    );
    expect(result.palette.hex).toEqual(["#FFFFFF", "#1E3CC8", "#C81E1E"]);
    expect(result.areaShare[0]).toBe(0);
    expect(result.areaShare[1]).toBeCloseTo(0.5);
    expect(result.warnings.join()).toContain("#FFFFFF");
  });
  it("reports lost detail before writing", async () => {
    const image = bands([[200, 30, 30]], 200);
    for (let y = 0; y < 200; y++)
      for (let x = 95; x < 200; x++) {
        const c = x < 105 ? [20, 20, 20] : [30, 60, 200],
          i = (y * 200 + x) * 4;
        image.data[i] = c[0]!;
        image.data[i + 1] = c[1]!;
        image.data[i + 2] = c[2]!;
      }
    try {
      await paint(image, 1);
      expect.fail("expected lost detail");
    } catch (error) {
      expect(error).toBeInstanceOf(ColorsLostError);
      if (error instanceof ColorsLostError) {
        expect(error.lost).toEqual(["#141414"]);
        expect(error.kept.sort()).toEqual(["#1E3CC8", "#C81E1E"]);
      }
    }
  });
  const mesh = grid(10),
    pairs = faceAdjacency(mesh.faces);
  it("removes isolated triangles but keeps a band", () => {
    const labels = Array<number>(200).fill(0),
      band = [
        ...Array.from({ length: 20 }, (_, i) => 50 + i),
        ...Array.from({ length: 20 }, (_, i) => 150 + i),
      ];
    band.forEach((i) => (labels[i] = 1));
    labels[22] = 1;
    const result = smooth(labels, pairs, 2, 1);
    expect(result[22]).toBe(0);
    expect(band.filter((i) => result[i] === 1).length / band.length).toBeGreaterThan(0.9);
  });
  it("never removes a colour entirely", () => {
    const labels = Array<number>(200).fill(0);
    labels[37] = 1;
    expect(smooth(labels, pairs, 2, 3)[37]).toBe(1);
  });
  it("fills unlabelled neighbours and disconnected shells", () => {
    const labels: number[] = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0 : 1));
    labels.fill(-1, 95, 105);
    expect(fillUnlabelled(labels, pairs, 2)).not.toContain(-1);
    expect(fillUnlabelled([-1, -1, 1], [], 2)).toEqual([1, 1, 1]);
  });
  it("welds duplicates and drops collapsed triangles", () =>
    expect(
      weld(
        [
          [0, 0, 0],
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        [
          [0, 2, 3],
          [0, 1, 2],
        ],
      ).faces,
    ).toEqual([[0, 1, 2]]));
});
