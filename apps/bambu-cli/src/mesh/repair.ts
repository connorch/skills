import { faceGeometry, weld } from "./geometry.ts";
import type { Mesh } from "./geometry.ts";
import { connectedComponents, diagnose, edgeUses } from "./topology.ts";

export function keepLargestBody(mesh: Mesh) {
  const { count, labels } = connectedComponents(mesh),
    { areas } = faceGeometry(mesh),
    totals = new Float64Array(count);
  for (let f = 0; f < labels.length; f++) totals[labels[f]!]! += areas[f]!;
  const largest = totals.reduce((best, area, i) => (area > totals[best]! ? i : best), 0),
    sum = totals.reduce((a, b) => a + b, 0),
    share = sum ? totals[largest]! / sum : 0;
  let note = "single body; nothing to remove",
    removed = 0;
  if (count > 1) {
    if (share <= 0.5)
      note = `not removed: the largest of ${count} bodies holds only ${(share * 100).toFixed(0)}% of the surface, so the others are probably real parts`;
    else {
      removed = count - 1;
      note = `kept the largest of ${count} bodies (${(share * 100).toFixed(0)}% of the surface)`;
      mesh = weld({
        ...mesh,
        indices: mesh.indices.filter((_, i) => labels[Math.floor(i / 3)] === largest),
      });
    }
  }
  return {
    mesh,
    result: {
      bodies: count,
      removed,
      kept_area_pct: count <= 1 ? 100 : Math.round(share * 1000) / 10,
      note,
    },
  };
}
// Minor repairs preserve the Model's surface; major topology stays for Studio.
export function repairMesh(input: Mesh) {
  const before = diagnose(input),
    steps: string[] = [],
    notes: string[] = [],
    seen = new Set<string>(),
    work = weld(input),
    { areas } = faceGeometry(work),
    faces: number[][] = [];
  for (let f = 0; f < areas.length; f++) {
    const face = Array.from(work.indices.slice(f * 3, f * 3 + 3)),
      key = face
        .slice()
        .sort((a, b) => a - b)
        .join(",");
    if (areas[f]! < 1e-12 || seen.has(key)) continue;
    seen.add(key);
    faces.push(face);
  }
  const removed = areas.length - faces.length;
  if (removed) steps.push(`removed ${removed} degenerate or duplicate faces`);
  let mesh = { ...work, indices: new Uint32Array(faces.flat()) };
  if (!before.winding_consistent) {
    const edges = edgeUses(mesh),
      neighbors = Array.from(
        { length: faces.length },
        () => [] as { face: number; flip: boolean }[],
      );
    for (const uses of edges.values())
      if (uses.length === 2) {
        const [a, b] = uses;
        neighbors[a!.face]!.push({ face: b!.face, flip: a!.a === b!.a });
        neighbors[b!.face]!.push({ face: a!.face, flip: a!.a === b!.a });
      }
    const flips = new Map<number, boolean>();
    for (let f = 0; f < faces.length; f++)
      if (!flips.has(f)) {
        flips.set(f, false);
        const stack = [f];
        while (stack.length) {
          const current = stack.pop()!;
          for (const n of neighbors[current]!)
            if (!flips.has(n.face)) {
              flips.set(n.face, flips.get(current)! !== n.flip);
              stack.push(n.face);
            }
        }
      }
    for (const [f, flip] of flips) if (flip) faces[f]!.reverse();
    mesh = { ...mesh, indices: new Uint32Array(faces.flat()) };
    steps.push("made face winding consistent");
  }
  if (before.boundary_edges) {
    const boundary = [...edgeUses(mesh).values()].filter((e) => e.length === 1).map((e) => e[0]!),
      unused = new Set(boundary),
      filled = faces.map((f) => f.slice());
    for (const start of boundary) {
      if (!unused.has(start)) continue;
      const loop = [start.a];
      let edge = start;
      while (unused.has(edge)) {
        unused.delete(edge);
        loop.push(edge.b);
        if (edge.b === start.a) break;
        const next = boundary.find((e) => unused.has(e) && e.a === edge.b);
        if (!next) break;
        edge = next;
      }
      if (loop.at(-1) !== loop[0]) continue;
      loop.pop();
      if (loop.length < 3 || loop.length > 4) continue;
      for (let i = 1; i < loop.length - 1; i++) filled.push([loop[0]!, loop[i + 1]!, loop[i]!]);
    }
    const candidate = { ...mesh, indices: new Uint32Array(filled.flat()) },
      after = diagnose(candidate);
    // Do not double open sheets or turn an existing face into a duplicate cap.
    const keys = filled.map((f) =>
      f
        .slice()
        .sort((a, b) => a - b)
        .join(","),
    );
    if (after.nonmanifold_edges > before.nonmanifold_edges || new Set(keys).size !== keys.length)
      notes.push("hole filling undone: it created non-manifold edges (open sheets?)");
    else if (after.boundary_edges < before.boundary_edges) {
      mesh = candidate;
      steps.push(`filled holes (${before.boundary_edges} -> ${after.boundary_edges} hole edges)`);
    }
  }
  if (diagnose(mesh).inside_out) {
    const indices = mesh.indices.slice();
    for (let i = 0; i < indices.length; i += 3)
      [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
    mesh = { ...mesh, indices };
    steps.push("turned the inside-out mesh the right way round");
  }
  const after = diagnose(mesh);
  if (after.boundary_edges)
    notes.push(
      `${after.boundary_edges} hole edges remain: use Fix Model in Bambu Studio (only minor repair is available)`,
    );
  if (after.nonmanifold_edges)
    notes.push(
      `${after.nonmanifold_edges} non-manifold edges remain: use Fix Model in Bambu Studio, or remesh in Blender (Remesh modifier, Voxel, 0.15-0.25 mm)`,
    );
  return { mesh: weld(mesh), result: { before, after, steps, notes }, changed: steps.length > 0 };
}
