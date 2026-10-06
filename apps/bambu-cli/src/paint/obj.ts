import type { Vec3 } from "./lab.ts";
import type { Face } from "./segment.ts";
import { argmin } from "./palette.ts";
// OBJ colours live on vertices, which take the majority label of their incident triangles.
export function vertexLabels(
  vertexCount: number,
  faces: Face[],
  labels: number[],
  colourCount: number,
) {
  const votes = Array.from({ length: vertexCount }, () => Array<number>(colourCount).fill(0));
  faces.forEach((face, i) => face.forEach((v) => votes[v]![labels[i]!]!++));
  return votes.map((v) => argmin(v.map((n) => -n)));
}
export function buildObj(
  vertices: Vec3[],
  faces: Face[],
  labels: number[],
  paletteRgb: Vec3[],
): string {
  const colours = vertexLabels(vertices.length, faces, labels, paletteRgb.length);
  return [
    "# bambu-studio-ai colorize: Z up, millimetres, sRGB vertex colours",
    ...vertices.map(
      (v, i) =>
        `v ${v.map((n) => n.toFixed(5)).join(" ")} ${paletteRgb[colours[i]!]!.map((n) => n.toFixed(4)).join(" ")}`,
    ),
    ...faces.map((f) => `f ${f.map((v) => v + 1).join(" ")}`),
    "",
  ].join("\n");
}
