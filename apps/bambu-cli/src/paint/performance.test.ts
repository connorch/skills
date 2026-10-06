import { expect, it } from "vite-plus/test";
import { paintModel } from "./pipeline.ts";
import { buildProject } from "./project.ts";
import { grid } from "./fixtures/builder.ts";
import type { ColouredModel } from "./load.ts";
it("paints over 200k triangles and a 2048 texture in seconds", () => {
  const mesh = grid(317, 80),
    width = 2048,
    data = new Uint8Array(width * width * 4),
    palette = [
      [220, 190, 50],
      [110, 60, 25],
      [20, 20, 20],
      [240, 240, 240],
    ];
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const c = palette[(Math.floor(x / 64) + Math.floor(y / 64) * 7) % 4]!,
        i = (y * width + x) * 4;
      data[i] = c[0]!;
      data[i + 1] = c[1]!;
      data[i + 2] = c[2]!;
      data[i + 3] = 255;
    }
  const model: ColouredModel = {
    vertices: mesh.positions,
    faces: mesh.faces,
    uv: mesh.uv,
    vertexColours: mesh.positions.map(() => [1, 1, 1, 1]),
    turned: false,
    parts: [
      {
        start: 0,
        end: mesh.faces.length,
        texture: { width, height: width, data },
        factor: [1, 1, 1, 1],
        alphaMode: "OPAQUE",
        alphaCutoff: 0.5,
        hasColour: true,
      },
    ],
    warnings: [],
  };
  const start = performance.now(),
    result = paintModel(model);
  buildProject(result.vertices, result.faces, result.labels, result.palette.hex, "big");
  expect(result.faces.length).toBeGreaterThan(200000);
  expect(result.palette.rgb).toHaveLength(4);
  expect(performance.now() - start).toBeLessThan(10000);
}, 15000);
