// TypeScript counterpart of upstream tests/glb_builder.py, for offline colour tests.
import { PNG } from "pngjs";
import type { GLTF } from "@gltf-transform/core";
import type { Vec3, Vec4 } from "../lab.ts";
import type { Face } from "../segment.ts";
export const RED: Vec3 = [200, 30, 30],
  GREEN: Vec3 = [30, 180, 40],
  BLUE: Vec3 = [30, 60, 200];
export function bands(colours: Vec3[], size = 64, alpha?: number[]) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const band = Math.min(colours.length - 1, Math.ceil(((x + 1) * colours.length) / size) - 1),
        c = colours[band]!,
        i = (y * size + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = alpha?.[band] ?? 255;
    }
  return { width: size, height: size, data };
}
export function grid(cells: number, width = 1) {
  const positions: Vec3[] = [],
    uv: [number, number][] = [],
    first: Face[] = [],
    second: Face[] = [];
  for (let y = 0; y <= cells; y++)
    for (let x = 0; x <= cells; x++) {
      uv.push([x / cells, y / cells]);
      positions.push([(x / cells) * width, (1 - y / cells) * width, 0]);
    }
  for (let y = 0; y < cells; y++)
    for (let x = 0; x < cells; x++) {
      const a = y * (cells + 1) + x,
        b = a + 1,
        c = a + cells + 1,
        d = c + 1;
      first.push([a, c, b]);
      second.push([b, c, d]);
    }
  return { positions, faces: [...first, ...second], uv };
}
export function box(size: Vec3 = [1, 1, 1]) {
  const positions: Vec3[] = [],
    faces: Face[] = [
      [0, 1, 3],
      [0, 3, 2],
      [4, 6, 7],
      [4, 7, 5],
      [0, 4, 5],
      [0, 5, 1],
      [2, 3, 7],
      [2, 7, 6],
      [0, 2, 6],
      [0, 6, 4],
      [1, 5, 7],
      [1, 7, 3],
    ];
  for (const x of [-1, 1])
    for (const y of [-1, 1])
      for (const z of [-1, 1])
        positions.push([(x * size[0]) / 2, (y * size[1]) / 2, (z * size[2]) / 2]);
  return {
    positions,
    faces,
    uv: positions.map(
      (p) => [(p[0] + size[0] / 2) / size[0], (p[1] + size[1] / 2) / size[1]] as [number, number],
    ),
  };
}
export function sphere(rings = 24, segments = 48, radius = 0.02) {
  const positions: Vec3[] = [],
    uv: [number, number][] = [],
    first: Face[] = [],
    second: Face[] = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const lat = (r / rings) * Math.PI,
        lon = (s / segments) * 2 * Math.PI;
      positions.push([
        radius * Math.sin(lat) * Math.cos(lon),
        radius * Math.cos(lat),
        radius * Math.sin(lat) * Math.sin(lon),
      ]);
      uv.push([s / segments, r / rings]);
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + 1,
        c = a + segments + 1,
        d = c + 1;
      first.push([a, b, c]);
      second.push([b, d, c]);
    }
  return { positions, faces: [...first, ...second], uv };
}
export function textured(
  index: number,
  factor?: Vec4,
  alphaMode?: "OPAQUE" | "BLEND" | "MASK",
): GLTF.IMaterial {
  return {
    pbrMetallicRoughness: {
      baseColorTexture: { index },
      ...(factor ? { baseColorFactor: factor } : {}),
    },
    ...(alphaMode ? { alphaMode } : {}),
  };
}
interface Primitive {
  positions: Vec3[];
  faces: Face[];
  uv?: [number, number][];
  colors?: Vec4[];
  material?: number;
}
export function glb(
  primitives: Primitive[],
  materials: GLTF.IMaterial[] = [],
  images: Uint8Array[] = [],
  matrices: number[][] = [],
) {
  const chunks: Buffer[] = [],
    bufferViews: GLTF.IBufferView[] = [],
    accessors: GLTF.IAccessor[] = [];
  let length = 0;
  function view(data: Uint8Array) {
    const padding = Buffer.alloc((4 - (length % 4)) % 4);
    chunks.push(padding);
    length += padding.length;
    const id = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.length });
    chunks.push(Buffer.from(data));
    length += data.length;
    return id;
  }
  function accessor(rows: number[][], type: GLTF.IAccessor["type"], componentType: 5126 | 5125) {
    const values = rows.flat(),
      data = Buffer.alloc(values.length * 4);
    values.forEach((v, i) =>
      componentType === 5126 ? data.writeFloatLE(v, i * 4) : data.writeUInt32LE(v, i * 4),
    );
    const id = accessors.length;
    accessors.push({
      bufferView: view(data),
      componentType,
      count: rows.length,
      type,
      ...(type === "VEC3"
        ? {
            min: [0, 1, 2].map((i) => Math.min(...rows.map((r) => r[i]!))),
            max: [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]!))),
          }
        : {}),
    });
    return id;
  }
  const meshes = primitives.map((p) => ({
    primitives: [
      {
        attributes: {
          POSITION: accessor(p.positions, "VEC3", 5126),
          ...(p.uv ? { TEXCOORD_0: accessor(p.uv, "VEC2", 5126) } : {}),
          ...(p.colors ? { COLOR_0: accessor(p.colors, "VEC4", 5126) } : {}),
        },
        indices: accessor(
          p.faces.flat().map((v) => [v]),
          "SCALAR",
          5125,
        ),
        ...(p.material !== undefined ? { material: p.material } : {}),
      },
    ],
  }));
  const imageEntries = images.map((data) => ({ bufferView: view(data), mimeType: "image/png" }));
  const json: GLTF.IGLTF = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: primitives.map((_, i) => i) }],
    nodes: primitives.map((_, i) => ({ mesh: i, ...(matrices[i] ? { matrix: matrices[i] } : {}) })),
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: length }],
    materials,
    images: imageEntries,
    textures: images.map((_, i) => ({ source: i })),
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]);
  let blob = Buffer.concat(chunks);
  blob = Buffer.concat([blob, Buffer.alloc((4 - (blob.length % 4)) % 4)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + text.length + blob.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(blob.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, text, binHeader, blob]);
}
export function png(image: ReturnType<typeof bands>) {
  const output = new PNG({ width: image.width, height: image.height });
  output.data = image.data;
  return PNG.sync.write(output);
}
