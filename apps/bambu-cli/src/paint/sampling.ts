import { linearToSrgb, srgbToLinear, unitClip, type Vec3, type Vec4 } from "./lab.ts";
import type { ColouredModel } from "./load.ts";
import { faceAreas } from "./segment.ts";
export function texelIndex(coord: number, size: number): number {
  const wrapped = coord < 0 || coord > 1 ? coord - Math.floor(coord) : coord;
  return Math.min(Math.trunc(wrapped * size), size - 1);
}
export function subTriangleCentres(level: number): Vec3[] {
  const centres: Vec3[] = [];
  for (let i = 0; i < level; i++)
    for (let j = 0; j < level - i; j++) {
      const s = (i + 1 / 3) / level,
        t = (j + 1 / 3) / level;
      centres.push([1 - s - t, s, t]);
      if (i + j <= level - 2) {
        const ss = (i + 2 / 3) / level,
          tt = (j + 2 / 3) / level;
        centres.push([1 - ss - tt, ss, tt]);
      }
    }
  return centres;
}
export interface Samples {
  face: number[];
  rgb: Vec3[];
  weight: number[];
  warnings: string[];
}
// Sample only UV footprints, with upstream's bounded sub-triangle grid and opacity weights.
export function sampleSurface(model: ColouredModel): Samples {
  const areas = faceAreas(model.vertices, model.faces),
    result: Samples = { face: [], rgb: [], weight: [], warnings: [] },
    grids = new Map<number, Vec3[]>();
  for (const part of model.parts) {
    const samples: { face: number; rgb: Vec3; area: number; alpha: number }[] = [],
      texture = part.texture;
    const texelAreas = Array.from({ length: part.end - part.start }, (_, i) => {
      if (!texture) return 0;
      const f = model.faces[part.start + i]!,
        uv = f.map((v) => model.uv[v]!);
      return (
        (Math.abs(
          (uv[1]![0] - uv[0]![0]) * (uv[2]![1] - uv[0]![1]) -
            (uv[1]![1] - uv[0]![1]) * (uv[2]![0] - uv[0]![0]),
        ) *
          texture.width *
          texture.height) /
        2
      );
    });
    const texelsPerSample = Math.max(2, texelAreas.reduce((s, v) => s + v, 0) / 2000000);
    for (let face = part.start; face < part.end; face++) {
      const f = model.faces[face]!,
        vertex = f.map((v) => model.vertexColours[v]!);
      const tinted = vertex.some((c) => c.some((v) => Math.abs(v - 1) > 1e-5));
      const level = texture
        ? Math.min(
            64,
            Math.max(1, Math.ceil(Math.sqrt(texelAreas[face - part.start]! / texelsPerSample))),
          )
        : 1;
      let grid = grids.get(level);
      if (!grid) {
        grid = subTriangleCentres(level);
        grids.set(level, grid);
      }
      const points = texture
        ? grid
        : tinted
          ? [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ]
          : [[1 / 3, 1 / 3, 1 / 3]];
      for (const bary of points) {
        let rgba: Vec4 = [1, 1, 1, 1];
        if (texture) {
          const uv = f.map((v) => model.uv[v]!),
            u = bary.reduce((s, v, i) => s + v * uv[i]![0], 0),
            v = bary.reduce((s, w, i) => s + w * uv[i]![1], 0);
          const index =
            (texelIndex(1 - v, texture.height) * texture.width + texelIndex(u, texture.width)) * 4;
          rgba = [
            texture.data[index]! / 255,
            texture.data[index + 1]! / 255,
            texture.data[index + 2]! / 255,
            texture.data[index + 3]! / 255,
          ];
        }
        const vc = [0, 1, 2, 3].map((k) => bary.reduce((s, w, i) => s + w * vertex[i]![k]!, 0));
        const rgb = [0, 1, 2].map((k) =>
          linearToSrgb(
            srgbToLinear(rgba[k]!) * part.factor[k]! * (tinted ? srgbToLinear(vc[k]!) : 1),
          ),
        ) as Vec3;
        const alpha = rgba[3] * part.factor[3] * (tinted ? vc[3]! : 1),
          opacity = part.alphaMode === "MASK" ? Number(alpha >= part.alphaCutoff) : unitClip(alpha);
        samples.push({ face, rgb, area: areas[face]! / points.length, alpha: opacity });
      }
    }
    const ignore =
      samples.reduce((s, v) => s + v.area * v.alpha, 0) <
      0.01 * samples.reduce((s, v) => s + v.area, 0);
    if (ignore)
      result.warnings.push("a texture is almost fully transparent; its alpha channel is ignored");
    for (const s of samples) {
      result.face.push(s.face);
      result.rgb.push(s.rgb);
      result.weight.push(s.area * (ignore ? 1 : s.alpha));
    }
  }
  result.warnings = [...new Set(result.warnings)];
  return result;
}
