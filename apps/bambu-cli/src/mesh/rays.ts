import { bounds, cross, dot, sub, triangle } from "./geometry.ts";
import type { Mesh, Vec3 } from "./geometry.ts";
interface Node {
  min: Vec3;
  max: Vec3;
  faces?: number[];
  left?: Node;
  right?: Node;
}
export interface RayHit {
  face: number;
  distance: number;
  leaving: boolean;
}
// A median-split BVH bounds ray work on detailed Models without native dependencies.
export class RayCaster {
  private readonly triangles: [Vec3, Vec3, Vec3][];
  private readonly root: Node;
  constructor(mesh: Mesh) {
    this.triangles = Array.from({ length: mesh.indices.length / 3 }, (_, f) => triangle(mesh, f));
    const lows = this.triangles.map(
        (t) => [0, 1, 2].map((a) => Math.min(...t.map((p) => p[a]!))) as Vec3,
      ),
      highs = this.triangles.map(
        (t) => [0, 1, 2].map((a) => Math.max(...t.map((p) => p[a]!))) as Vec3,
      );
    const build = (faces: number[]): Node => {
      const min: Vec3 = [Infinity, Infinity, Infinity],
        max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const f of faces)
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, lows[f]![a]!);
          max[a] = Math.max(max[a]!, highs[f]![a]!);
        }
      if (faces.length <= 8) return { min, max, faces };
      const extents = sub(max, min),
        axis = extents.indexOf(Math.max(...extents));
      faces.sort(
        (a, b) => lows[a]![axis]! + highs[a]![axis]! - (lows[b]![axis]! + highs[b]![axis]!),
      );
      const mid = faces.length >>> 1;
      return { min, max, left: build(faces.slice(0, mid)), right: build(faces.slice(mid)) };
    };
    this.root = build(this.triangles.map((_, f) => f));
  }
  hits(origin: Vec3, direction: Vec3, maxDistance = Infinity): RayHit[] {
    const result: RayHit[] = [],
      stack = [this.root];
    while (stack.length) {
      const node = stack.pop()!;
      let low = 0,
        high = maxDistance;
      for (let axis = 0; axis < 3; axis++) {
        const d = direction[axis]!,
          o = origin[axis]!;
        if (Math.abs(d) < 1e-15) {
          if (o < node.min[axis]! - 1e-9 || o > node.max[axis]! + 1e-9) high = -1;
        } else {
          const a = (node.min[axis]! - o) / d,
            b = (node.max[axis]! - o) / d;
          low = Math.max(low, Math.min(a, b));
          high = Math.min(high, Math.max(a, b));
        }
      }
      if (high < low) continue;
      if (node.faces)
        for (const face of node.faces) {
          const hit = intersect(this.triangles[face]!, origin, direction);
          if (hit && hit.distance <= maxDistance) result.push({ face, ...hit });
        }
      else {
        if (node.left) stack.push(node.left);
        if (node.right) stack.push(node.right);
      }
    }
    return result.sort((a, b) => a.distance - b.distance);
  }
  firstExit(origin: Vec3, direction: Vec3, maxDistance = 10): number {
    return this.hits(origin, direction, maxDistance).find((h) => h.leaving)?.distance ?? Infinity;
  }
}
export function intersect(t: [Vec3, Vec3, Vec3], origin: Vec3, direction: Vec3) {
  const [a, b, c] = t,
    e1 = sub(b, a),
    e2 = sub(c, a),
    p = cross(direction, e2),
    det = dot(e1, p);
  if (Math.abs(det) <= 1e-12) return undefined;
  const offset = sub(origin, a),
    u = dot(offset, p) / det,
    q = cross(offset, e1),
    v = dot(direction, q) / det,
    distance = dot(e2, q) / det;
  if (u < 0 || v < 0 || u + v > 1 || distance <= 1e-12) return undefined;
  return { distance, leaving: det < 0 };
}
export function materialBelow(mesh: Mesh, points: Vec3[], caster = new RayCaster(mesh)): number[] {
  const largest = Math.max(...bounds(mesh).extents);
  return points.map((p) =>
    caster
      .hits([p[0] + largest * 1.3e-6, p[1] + largest * 0.7e-6, p[2]], [0, 0, -1])
      .reduce((sum, h) => sum + (h.leaving ? 1 : -1), 0),
  );
}
