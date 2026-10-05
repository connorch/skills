import {
  add,
  bounds,
  cross,
  dot,
  faceGeometry,
  merge,
  mul,
  rotate,
  sub,
  translate,
  triangle,
  vertex,
} from "./geometry.ts";
import type { Mesh, Vec3 } from "./geometry.ts";
import { diagnose } from "./topology.ts";
import { checkBedContact, round } from "./checks.ts";
interface HullFace {
  vertices: [number, number, number];
  normal: Vec3;
  offset: number;
  outside: number[];
}
// QuickHull assigns outside vertices to faces and expands visible regions at their horizons.
export function convexHull(mesh: Mesh): Mesh {
  const points = Array.from({ length: mesh.positions.length / 3 }, (_, i) => vertex(mesh, i));
  if (points.length < 4) throw new Error("not enough vertices for a hull");
  const tolerance = Math.max(...bounds(mesh).extents) * 1e-7;
  const first = points.reduce((best, p, i) => (p[0] < points[best]![0] ? i : best), 0),
    a = points[first]!;
  const furthest = (distance: (p: Vec3) => number, excluded: number[] = []) => {
    let best = -1,
      value = -Infinity;
    points.forEach((p, i) => {
      const d = distance(p);
      if (!excluded.includes(i) && d > value) {
        value = d;
        best = i;
      }
    });
    return best;
  };
  const second = furthest((p) => dot(sub(p, a), sub(p, a)), [first]),
    b = points[second]!,
    third = furthest((p) => Math.hypot(...cross(sub(b, a), sub(p, a))), [first, second]),
    c = points[third]!,
    normal = cross(sub(b, a), sub(c, a)),
    fourth = furthest((p) => Math.abs(dot(normal, sub(p, a))), [first, second, third]);
  if (
    fourth < 0 ||
    Math.abs(dot(normal, sub(points[fourth]!, a))) < tolerance * Math.hypot(...normal)
  )
    throw new Error("flat Model has no 3D hull");
  const centre = mul(add(add(a, b), add(c, points[fourth]!)), 0.25),
    faces = new Set<HullFace>(),
    edges = new Map<string, HullFace>();
  const key = (a: number, b: number) => `${a},${b}`;
  function make(v: [number, number, number]): HullFace {
    let n = cross(sub(points[v[1]]!, points[v[0]]!), sub(points[v[2]]!, points[v[0]]!));
    if (dot(n, sub(centre, points[v[0]]!)) > 0) {
      [v[1], v[2]] = [v[2], v[1]];
      n = mul(n, -1);
    }
    n = mul(n, 1 / Math.hypot(...n));
    const face = { vertices: v, normal: n, offset: dot(n, points[v[0]]!), outside: [] as number[] };
    faces.add(face);
    for (let i = 0; i < 3; i++) edges.set(key(v[i]!, v[(i + 1) % 3]!), face);
    return face;
  }
  const distance = (f: HullFace, p: number) => dot(f.normal, points[p]!) - f.offset;
  const initial = [
    make([first, second, third]),
    make([first, fourth, second]),
    make([second, fourth, third]),
    make([third, fourth, first]),
  ];
  const assign = (p: number, candidates: HullFace[]) => {
    let best: HullFace | undefined,
      d = tolerance;
    for (const f of candidates) {
      const v = distance(f, p);
      if (v > d) {
        best = f;
        d = v;
      }
    }
    best?.outside.push(p);
  };
  const tetra = new Set([first, second, third, fourth]);
  points.forEach((_, p) => {
    if (!tetra.has(p)) assign(p, initial);
  });
  const pending = initial.slice();
  while (pending.length) {
    const start = pending.pop()!;
    if (!faces.has(start) || !start.outside.length) continue;
    const eye = start.outside.reduce((a, b) => (distance(start, b) > distance(start, a) ? b : a)),
      visible = new Set<HullFace>(),
      stack = [start];
    while (stack.length) {
      const f = stack.pop()!;
      if (visible.has(f) || distance(f, eye) <= tolerance) continue;
      visible.add(f);
      for (let i = 0; i < 3; i++) {
        const neighbor = edges.get(key(f.vertices[(i + 1) % 3]!, f.vertices[i]!));
        if (neighbor && !visible.has(neighbor)) stack.push(neighbor);
      }
    }
    const horizon: [number, number][] = [],
      orphans = new Set<number>();
    for (const f of visible) {
      for (const p of f.outside) if (p !== eye) orphans.add(p);
      for (let i = 0; i < 3; i++) {
        const u = f.vertices[i]!,
          v = f.vertices[(i + 1) % 3]!,
          neighbor = edges.get(key(v, u));
        if (!neighbor || !visible.has(neighbor)) horizon.push([u, v]);
      }
    }
    for (const f of visible) {
      faces.delete(f);
      for (let i = 0; i < 3; i++) edges.delete(key(f.vertices[i]!, f.vertices[(i + 1) % 3]!));
    }
    const created = horizon.map(([u, v]) => make([u, v, eye]));
    for (const p of orphans) assign(p, created);
    pending.push(...created);
  }
  return merge(
    [{ ...mesh, indices: new Uint32Array([...faces].flatMap((f) => f.vertices)) }],
    "hull",
  );
}
function alignDown(mesh: Mesh, normal: Vec3): Mesh {
  const down: Vec3 = [0, 0, -1],
    axis = cross(normal, down),
    length = Math.hypot(...axis),
    cos = dot(normal, down);
  if (length < 1e-8) return cos > 0 ? mesh : rotate(mesh, [1, 0, 0], Math.PI);
  return rotate(mesh, mul(axis, 1 / length), Math.acos(Math.max(-1, Math.min(1, cos))));
}
// Centre of mass for closed Models, or the surface centroid when volume is undefined.
export function centreOfMass(mesh: Mesh): Vec3 {
  const geometry = faceGeometry(mesh);
  let weighted: Vec3 = [0, 0, 0],
    weight = 0;
  const closed = diagnose(mesh).watertight && geometry.volume > 0;
  for (let f = 0; f < geometry.areas.length; f++) {
    const [a, b, c] = triangle(mesh, f),
      w = closed ? dot(a, cross(b, c)) / 6 : geometry.areas[f]!;
    weighted = add(weighted, mul(add(add(a, b), c), w / (closed ? 4 : 3)));
    weight += w;
  }
  return weight ? mul(weighted, 1 / weight) : mul(add(bounds(mesh).min, bounds(mesh).max), 0.5);
}
// Hull support areas weight poses whose centre projects onto their support polygon.
export function stableRestingPoses(mesh: Mesh) {
  const hull = convexHull(mesh),
    { normals, areas } = faceGeometry(hull),
    centre = centreOfMass(mesh),
    groups = new Map<string, { normal: Vec3; support_area_mm2: number; stable: boolean }>();
  for (let f = 0; f < normals.length; f++) {
    const normal = normals[f]!,
      key = normal.map((v) => Math.round(v * 1e5)).join(","),
      group = groups.get(key) ?? { normal, support_area_mm2: 0, stable: false };
    group.support_area_mm2 += areas[f]!;
    const [a, b, c] = triangle(hull, f),
      projected = sub(centre, mul(normal, dot(normal, sub(centre, a)))),
      e0 = sub(b, a),
      e1 = sub(c, a),
      v = sub(projected, a),
      d00 = dot(e0, e0),
      d01 = dot(e0, e1),
      d11 = dot(e1, e1),
      denominator = d00 * d11 - d01 * d01;
    const u = (d11 * dot(v, e0) - d01 * dot(v, e1)) / denominator,
      w = (d00 * dot(v, e1) - d01 * dot(v, e0)) / denominator;
    if (u >= -1e-6 && w >= -1e-6 && u + w <= 1 + 1e-6) group.stable = true;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.stable)
    .sort((a, b) => b.support_area_mm2 - a.support_area_mm2)
    .slice(0, 20)
    .map((g) => ({ ...g, mesh: alignDown(mesh, g.normal) }));
}
export function orientForPrinting(mesh: Mesh) {
  const before = checkBedContact(mesh).contact_mm2;
  let chosen = mesh,
    reason = "kept: no resting poses found",
    rotated = false;
  try {
    const poses = stableRestingPoses(mesh).map((p) => ({
        ...p,
        contact: checkBedContact(p.mesh).contact_mm2,
      })),
      largest = Math.max(0, ...poses.map((p) => p.contact));
    if (before > 0 && before >= largest * 0.5)
      reason = `kept: already rests on a flat base (${before.toFixed(0)} mm2 on the plate)`;
    else {
      let best = -Infinity;
      for (const p of poses) {
        if (p.contact < largest * 0.5) continue;
        const [x, y, z] = bounds(p.mesh).extents,
          value = (p.support_area_mm2 * x * y) / Math.max(z, 0.001);
        if (value > best) {
          best = value;
          chosen = p.mesh;
        }
      }
      if (chosen !== mesh) {
        rotated = true;
        reason = `turned onto a flat base (${checkBedContact(chosen).contact_mm2.toFixed(0)} mm2 on the plate, was ${before.toFixed(0)} mm2)`;
      }
    }
  } catch (error) {
    reason = `kept: no resting poses could be computed (${error instanceof Error ? error.message : String(error)})`;
  }
  const drop = -bounds(chosen).min[2];
  if (drop) chosen = translate(chosen, [0, 0, drop]);
  return {
    mesh: chosen,
    result: {
      rotated,
      moved: rotated || Boolean(drop),
      reason,
      contact_before_mm2: round(before),
      contact_after_mm2: checkBedContact(chosen).contact_mm2,
    },
  };
}
