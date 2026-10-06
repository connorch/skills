// Recreated from upstream tests/mesh_shapes.py, which generates fixtures at runtime.
import { merge, rotate, translate, weld } from "./geometry.ts";
import type { Mesh, Vec3 } from "./geometry.ts";
import { convexHull } from "./orient.ts";
export function box(x = 30, y = x, z = x, at: Vec3 = [0, 0, 0]): Mesh {
  return translate(
    {
      positions: new Float32Array([
        0,
        0,
        0,
        x,
        0,
        0,
        x,
        y,
        0,
        0,
        y,
        0,
        0,
        0,
        z,
        x,
        0,
        z,
        x,
        y,
        z,
        0,
        y,
        z,
      ]),
      indices: new Uint32Array([
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
        0, 4, 3, 4, 7,
      ]),
      source: { format: "stl" },
    },
    at,
  );
}
export function wedge(angle: number): Mesh {
  const lean = 20 * Math.tan((angle * Math.PI) / 180),
    mesh = box(20);
  for (let i = 4; i < 8; i++)
    mesh.positions[i * 3] = mesh.positions[i * 3] === 0 ? -lean : 20 + lean;
  return convexHull(mesh);
}
export function missingTriangle(): Mesh {
  const mesh = box();
  return { ...mesh, indices: mesh.indices.slice(3) };
}
export function sheets(): Mesh {
  return {
    positions: new Float32Array([
      0, 0, 0, 50, 0, 0, 50, 50, 0, 0, 50, 0, 0, 0, 50, 50, 0, 50, 50, 50, 50, 0, 50, 50,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
    source: { format: "stl" },
  };
}
export function tShape(): Mesh {
  return merge([box(10, 10, 30, [-5, -5, 0]), box(60, 10, 5, [-30, -5, 30])]);
}
export function sphere(radius = 30, segments = 64, rings = 32): Mesh {
  const positions: number[] = [0, 0, radius],
    indices: number[] = [];
  for (let r = 1; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const theta = (Math.PI * r) / rings,
        phi = (2 * Math.PI * s) / segments;
      positions.push(
        radius * Math.sin(theta) * Math.cos(phi),
        radius * Math.sin(theta) * Math.sin(phi),
        radius * Math.cos(theta),
      );
    }
  const bottom = positions.length / 3;
  positions.push(0, 0, -radius);
  for (let s = 0; s < segments; s++) indices.push(0, 1 + s, 1 + ((s + 1) % segments));
  for (let r = 0; r < rings - 2; r++)
    for (let s = 0; s < segments; s++) {
      const a = 1 + r * segments + s,
        b = 1 + r * segments + ((s + 1) % segments),
        c = a + segments,
        d = b + segments;
      indices.push(a, c, b, b, c, d);
    }
  for (let s = 0; s < segments; s++)
    indices.push(
      bottom,
      1 + (rings - 2) * segments + ((s + 1) % segments),
      1 + (rings - 2) * segments + s,
    );
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    source: { format: "stl" },
  };
}
export function hollowSphere(radius = 30, wall = 0.6): Mesh {
  const inner = sphere(radius - wall);
  for (let f = 0; f < inner.indices.length; f += 3)
    [inner.indices[f + 1], inner.indices[f + 2]] = [inner.indices[f + 2]!, inner.indices[f + 1]!];
  return translate(merge([sphere(radius), inner]), [0, 0, radius]);
}
export function cup(): Mesh {
  const positions: number[] = [],
    indices: number[] = [],
    segments = 64;
  for (const [radius, z] of [
    [20, 0],
    [20, 90],
    [18, 90],
    [18, 2],
  ])
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      positions.push(radius! * Math.cos(a), radius! * Math.sin(a), z!);
    }
  for (let ring = 0; ring < 3; ring++)
    for (let i = 0; i < segments; i++) {
      const a = ring * segments + i,
        b = ring * segments + ((i + 1) % segments),
        c = a + segments,
        d = b + segments;
      indices.push(a, b, c, b, d, c);
    }
  const bottom = positions.length / 3;
  positions.push(0, 0, 0);
  const floor = positions.length / 3;
  positions.push(0, 0, 2);
  for (let i = 0; i < segments; i++) {
    indices.push(bottom, (i + 1) % segments, i);
    indices.push(floor, 3 * segments + i, 3 * segments + ((i + 1) % segments));
  }
  return weld({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    source: { format: "stl" },
  });
}
export const lyingCup = () => rotate(cup(), [1, 0, 0], Math.PI / 2);
