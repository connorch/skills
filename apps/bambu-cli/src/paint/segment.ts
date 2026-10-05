import { roundEven, type Vec3 } from "./lab.ts";
import { argmin } from "./palette.ts";
export type Face = [number, number, number];
// Join UV-seam duplicates before adjacency, dropping collapsed triangles.
export function weld(vertices: Vec3[], faces: Face[]) {
  const map = new Map<string, number>(),
    points: Vec3[] = [],
    inverse = vertices.map((v) => {
      const key = v.map((n) => roundEven(n / 1e-5)).join(",");
      let id = map.get(key);
      if (id === undefined) {
        id = points.length;
        map.set(key, id);
        points.push(v);
      }
      return id;
    });
  const kept: Face[] = [],
    sourceFace: number[] = [];
  faces.forEach((f, i) => {
    const row = f.map((v) => inverse[v]!) as Face;
    if (new Set(row).size === 3) {
      kept.push(row);
      sourceFace.push(i);
    }
  });
  return { vertices: points, faces: kept, sourceFace };
}
export function faceAdjacency(faces: Face[]): [number, number][] {
  const edges = new Map<string, number[]>();
  faces.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      const a = f[k]!,
        b = f[(k + 1) % 3]!;
      const key = `${Math.min(a, b)},${Math.max(a, b)}`;
      const owners = edges.get(key);
      if (owners) owners.push(i);
      else edges.set(key, [i]);
    }
  });
  return [...edges.values()].filter((v) => v.length === 2).map((v) => [v[0]!, v[1]!]);
}
export function voteFaces(
  sampleFace: number[],
  sampleLabel: number[],
  weight: number[],
  faceCount: number,
  colourCount: number,
): number[] {
  const votes = Array.from({ length: faceCount }, () => Array<number>(colourCount).fill(0));
  sampleFace.forEach((f, i) => (votes[f]![sampleLabel[i]!]! += weight[i]!));
  return votes.map((v) => (v.reduce((a, b) => a + b, 0) > 0 ? argmin(v.map((n) => -n)) : -1));
}
function neighbourVotes(labels: number[], pairs: [number, number][], count: number) {
  const votes = labels.map(() => Array<number>(count).fill(0));
  for (const [a, b] of pairs) {
    if (labels[a]! >= 0) votes[b]![labels[a]!]!++;
    if (labels[b]! >= 0) votes[a]![labels[b]!]!++;
  }
  return votes;
}
export function fillUnlabelled(
  initial: number[],
  pairs: [number, number][],
  count: number,
): number[] {
  let labels = [...initial];
  for (let i = 0; i < 10000 && labels.includes(-1); i++) {
    const votes = neighbourVotes(labels, pairs, count);
    let changed = false;
    labels = labels.map((label, j) => {
      if (label !== -1 || !votes[j]!.some((v) => v > 0)) return label;
      changed = true;
      return argmin(votes[j]!.map((v) => -v));
    });
    if (!changed) break;
  }
  const mass = Array<number>(count).fill(0);
  labels.forEach((v) => {
    if (v >= 0) mass[v]!++;
  });
  const fallback = argmin(mass.map((v) => -v));
  return labels.map((v) => (v < 0 ? fallback : v));
}
export function smooth(
  initial: number[],
  pairs: [number, number][],
  count: number,
  passes: number,
): number[] {
  let labels = [...initial];
  for (let i = 0; i < passes; i++) {
    const votes = neighbourVotes(labels, pairs, count);
    labels = labels.map((own, j) => {
      const v = votes[j]!,
        best = argmin(v.map((n) => -n));
      return v[best]! >= 2 && v[best]! > v[own]! ? best : own;
    });
  }
  const present = new Set(labels);
  const lost = new Set(initial.filter((v) => !present.has(v)));
  return labels.map((v, i) => (lost.has(initial[i]!) ? initial[i]! : v));
}
export function faceAreas(vertices: Vec3[], faces: Face[]): number[] {
  return faces.map(([a, b, c]) => {
    const p = vertices[a]!,
      q = vertices[b]!,
      r = vertices[c]!;
    const u = q.map((v, i) => v - p[i]!),
      v = r.map((n, i) => n - p[i]!);
    return (
      Math.hypot(
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ) / 2
    );
  });
}
