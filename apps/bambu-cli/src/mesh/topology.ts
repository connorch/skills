import { faceGeometry, weld } from "./geometry.ts";
import type { Mesh } from "./geometry.ts";

export function edgeUses(mesh: Mesh) {
  const edges = new Map<string, { face: number; a: number; b: number }[]>();
  for (let f = 0; f < mesh.indices.length / 3; f++)
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[f * 3 + k]!,
        b = mesh.indices[f * 3 + ((k + 1) % 3)]!,
        key = `${Math.min(a, b)},${Math.max(a, b)}`;
      const uses = edges.get(key) ?? [];
      uses.push({ face: f, a, b });
      edges.set(key, uses);
    }
  return edges;
}
// Upstream bodies connect through vertices, including non-manifold junctions.
export function connectedComponents(input: Mesh) {
  const mesh = weld(input),
    parent = Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let f = 0; f < mesh.indices.length; f += 3) {
    const a = root(mesh.indices[f]!);
    parent[root(mesh.indices[f + 1]!)] = a;
    parent[root(mesh.indices[f + 2]!)] = a;
  }
  const groups = new Map<number, number>(),
    labels = new Uint32Array(mesh.indices.length / 3);
  for (let f = 0; f < labels.length; f++) {
    const r = root(mesh.indices[f * 3]!);
    if (!groups.has(r)) groups.set(r, groups.size);
    labels[f] = groups.get(r)!;
  }
  return { count: groups.size, labels };
}
export function diagnose(input: Mesh) {
  const mesh = weld(input),
    edges = edgeUses(mesh);
  let boundary = 0,
    nonmanifold = 0,
    consistent = true;
  for (const uses of edges.values()) {
    if (uses.length === 1) boundary++;
    if (uses.length > 2) nonmanifold++;
    if (uses.length === 2 && uses[0]!.a === uses[1]!.a) consistent = false;
  }
  const geometry = faceGeometry(mesh),
    watertight = !boundary && !nonmanifold,
    inside = watertight && consistent && geometry.volume < 0;
  const degenerate = [...geometry.areas].filter((a) => a < 1e-12).length;
  return {
    faces: mesh.indices.length / 3,
    watertight,
    winding_consistent: consistent,
    inside_out: inside,
    boundary_edges: boundary,
    nonmanifold_edges: nonmanifold,
    degenerate_faces: degenerate,
    bodies: connectedComponents(mesh).count,
    repair_tier: nonmanifold
      ? ("major" as const)
      : watertight && consistent && !inside && !degenerate
        ? ("none" as const)
        : ("minor" as const),
  };
}
export type MeshDiagnosis = ReturnType<typeof diagnose>;
export function isWatertight(mesh: Mesh): boolean {
  return diagnose(mesh).watertight;
}
export function isWindingConsistent(mesh: Mesh): boolean {
  return diagnose(mesh).winding_consistent;
}
