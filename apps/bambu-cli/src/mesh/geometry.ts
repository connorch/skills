export type Vec3 = [number, number, number];
export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
  unit?: string;
  source: { format: string };
}
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function vertex(mesh: Mesh, i: number): Vec3 {
  return [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
}
export function triangle(mesh: Mesh, face: number): [Vec3, Vec3, Vec3] {
  return [
    vertex(mesh, mesh.indices[face * 3]!),
    vertex(mesh, mesh.indices[face * 3 + 1]!),
    vertex(mesh, mesh.indices[face * 3 + 2]!),
  ];
}
export function bounds(mesh: Mesh) {
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const i of mesh.indices) {
    const p = vertex(mesh, i);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, p[axis]!);
      max[axis] = Math.max(max[axis]!, p[axis]!);
    }
  }
  return { min, max, extents: sub(max, min) };
}
export function faceGeometry(mesh: Mesh) {
  const areas = new Float64Array(mesh.indices.length / 3),
    normals: Vec3[] = [];
  let volume = 0,
    area = 0;
  for (let f = 0; f < areas.length; f++) {
    const [a, b, c] = triangle(mesh, f),
      n = cross(sub(b, a), sub(c, a)),
      length = Math.hypot(...n);
    areas[f] = length / 2;
    area += length / 2;
    normals.push(length ? mul(n, 1 / length) : [0, 0, 0]);
    volume += dot(a, cross(b, c)) / 6;
  }
  return { areas, normals, area, volume };
}
export function surfaceArea(mesh: Mesh): number {
  return faceGeometry(mesh).area;
}
export function signedVolume(mesh: Mesh): number {
  return faceGeometry(mesh).volume;
}
export function triangleNormals(mesh: Mesh): Vec3[] {
  return faceGeometry(mesh).normals;
}

// Weld coincident corners so STL and other unindexed Models share topology.
export function weld(mesh: Mesh): Mesh {
  const positions: number[] = [],
    indices: number[] = [],
    lookup = new Map<string, number>();
  for (const i of mesh.indices) {
    const p = vertex(mesh, i),
      key = p.map((v) => Math.round(v * 1e8)).join(",");
    let index = lookup.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      lookup.set(key, index);
      positions.push(...p);
    }
    indices.push(index);
  }
  return { ...mesh, positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
export function merge(meshes: Mesh[], format = meshes[0]?.source.format ?? "stl"): Mesh {
  const positions: number[] = [],
    indices: number[] = [];
  for (const mesh of meshes) {
    const offset = positions.length / 3;
    for (const p of mesh.positions) positions.push(p);
    for (const i of mesh.indices) indices.push(i + offset);
  }
  return weld({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    source: { format },
  });
}
export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Column-major transforms match glTF; reflections also reverse winding.
export function transform(mesh: Mesh, matrix: readonly number[]): Mesh {
  const positions = new Float32Array(mesh.positions.length),
    indices = mesh.indices.slice();
  for (let i = 0; i < positions.length / 3; i++) {
    const p = vertex(mesh, i);
    for (let j = 0; j < 3; j++)
      positions[i * 3 + j] =
        matrix[j]! * p[0] + matrix[4 + j]! * p[1] + matrix[8 + j]! * p[2] + matrix[12 + j]!;
  }
  const det = dot(
    [matrix[0]!, matrix[1]!, matrix[2]!],
    cross([matrix[4]!, matrix[5]!, matrix[6]!], [matrix[8]!, matrix[9]!, matrix[10]!]),
  );
  if (det < 0)
    for (let f = 0; f < indices.length; f += 3)
      [indices[f + 1], indices[f + 2]] = [indices[f + 2]!, indices[f + 1]!];
  return { ...mesh, positions, indices };
}
export function matrixMultiply(a: readonly number[], b: readonly number[]): number[] {
  return Array.from({ length: 16 }, (_, i) => {
    const row = i % 4,
      col = Math.floor(i / 4);
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
    return sum;
  });
}
export function scale(mesh: Mesh, factor: number): Mesh {
  const m = identity.slice();
  m[0] = m[5] = m[10] = factor;
  return transform(mesh, m);
}
export function translate(mesh: Mesh, offset: Vec3): Mesh {
  const m = identity.slice();
  m.splice(12, 3, ...offset);
  return transform(mesh, m);
}
export function rotate(mesh: Mesh, axis: Vec3, angle: number): Mesh {
  const [x, y, z] = mul(axis, 1 / Math.hypot(...axis)),
    c = Math.cos(angle),
    s = Math.sin(angle),
    t = 1 - c;
  return transform(mesh, [
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  ]);
}
// Deterministic area-weighted samples make offline reports reproducible.
export function sampleSurface(mesh: Mesh, count = 2000, seed = 0) {
  const { areas, area } = faceGeometry(mesh),
    cumulative: number[] = [];
  let total = 0,
    state = seed;
  for (const a of areas) {
    total += a;
    cumulative.push(total);
  }
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const faces: number[] = [],
    points: Vec3[] = [];
  if (area <= 0) return { faces, points };
  for (let i = 0; i < count; i++) {
    const target = random() * area;
    let low = 0,
      high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (cumulative[mid]! < target) low = mid + 1;
      else high = mid;
    }
    let u = random(),
      v = random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const [a, b, c] = triangle(mesh, low);
    points.push(add(a, add(mul(sub(b, a), u), mul(sub(c, a), v))));
    faces.push(low);
  }
  return { faces, points };
}
