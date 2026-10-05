import { deltaE2000, labToSrgb, parseHex, srgbToLab, toHex, type Vec3 } from "./lab.ts";
export interface ColourBins {
  lab: Vec3[];
  weight: number[];
  ofSample: number[];
}
export class Palette {
  constructor(readonly rgb: Vec3[]) {}
  get lab() {
    return this.rgb.map(srgbToLab);
  }
  get hex() {
    return this.rgb.map(toHex);
  }
  static fromHex(colors: string[]) {
    if (colors.length < 1 || colors.length > 8)
      throw new RangeError("give between 1 and 8 colours");
    return new Palette(colors.map(parseHex));
  }
  static fromLab(lab: Vec3[]) {
    return Palette.fromHex(lab.map((c) => toHex(labToSrgb(c))));
  }
}
export function argmin(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i]! < values[best]!) best = i;
  return best;
}
const squared = (a: Vec3, b: Vec3) => a.reduce((s, v, i) => s + (v - b[i]!) ** 2, 0);
const nearest = (lab: Vec3[], centres: Vec3[]) =>
  lab.map((c) => argmin(centres.map((p) => squared(c, p))));
export function assign(lab: Vec3[], palette: Palette): number[] {
  const centres = palette.lab;
  return lab.map((c) => argmin(centres.map((p) => deltaE2000(c, p))));
}
// Bin colours by sRGB cube; the bin colour is an unweighted mean, as upstream specifies.
export function binColours(rgb: Vec3[], weight: number[]): ColourBins {
  const keys = rgb.map((c) => c.reduce((s, v) => s * 32 + Math.min(Math.trunc(v * 32), 31), 0));
  const unique = [...new Set(keys)].sort((a, b) => a - b),
    lookup = new Map(unique.map((v, i) => [v, i]));
  const ofSample = keys.map((k) => lookup.get(k)!);
  const counts = unique.map(() => 0),
    mass = unique.map(() => 0),
    sums = unique.map((): Vec3 => [0, 0, 0]);
  rgb.forEach((c, i) => {
    const j = ofSample[i]!;
    counts[j]!++;
    mass[j]! += weight[i]!;
    c.forEach((v, k) => (sums[j]![k]! += v));
  });
  return {
    lab: sums.map((c, i) => srgbToLab(c.map((v) => v / counts[i]!) as Vec3)),
    weight: mass,
    ofSample,
  };
}
function cluster(lab: Vec3[], weight: number[], centres: Vec3[]) {
  const labels = nearest(lab, centres),
    mass = centres.map(() => 0),
    sums = centres.map((): Vec3 => [0, 0, 0]);
  lab.forEach((c, i) => {
    const j = labels[i]!;
    mass[j]! += weight[i]!;
    c.forEach((v, k) => (sums[j]![k]! += v * weight[i]!));
  });
  const active = mass.flatMap((value, i) => (value > 0 ? [i] : []));
  return {
    centres: active.map((i) => sums[i]!.map((v) => v / mass[i]!) as Vec3),
    mass: active.map((i) => mass[i]!),
  };
}
function lloyd(lab: Vec3[], weight: number[], initial: Vec3[]) {
  let centres = initial,
    labels = nearest(lab, centres);
  for (let i = 0; i < 40; i++) {
    centres = cluster(lab, weight, centres).centres;
    const next = nearest(lab, centres);
    if (next.every((v, j) => v === labels[j])) break;
    labels = next;
  }
  return centres;
}
function merge(initial: Vec3[], weights: number[], max: number, min: number) {
  const centres = initial.map((c) => [...c] as Vec3),
    mass = [...weights];
  while (centres.length > 1) {
    const distances = centres.map((a, i) =>
      centres.map((b, j) => (i === j ? Infinity : deltaE2000(a, b))),
    );
    const smallest = argmin(mass),
      flat = distances.flat(),
      pair = argmin(flat);
    let source: number, target: number;
    if (mass[smallest]! < min) {
      source = smallest;
      target = argmin(distances[source]!);
    } else if (centres.length > max || flat[pair]! < 10) {
      source = Math.floor(pair / centres.length);
      target = pair % centres.length;
    } else break;
    const total = mass[source]! + mass[target]!;
    centres[target] = centres[target]!.map(
      (v, i) => (v * mass[target]! + centres[source]![i]! * mass[source]!) / total,
    ) as Vec3;
    mass[target] = total;
    centres.splice(source, 1);
    mass.splice(source, 1);
  }
  return centres;
}
// Deterministic farthest-point weighted k-means, minimum-area merging and dominant colours.
export function selectPalette(bins: ColourBins, maxColors = 4, minArea = 0.002): Palette {
  if (!Number.isInteger(maxColors) || maxColors < 1 || maxColors > 8)
    throw new RangeError("max_colors must be between 1 and 8");
  const lab = bins.lab.filter((_, i) => bins.weight[i]! > 0),
    weight = bins.weight.filter((v) => v > 0);
  if (!lab.length) throw new Error("no visible colour: every sampled texel is transparent");
  const min = minArea * weight.reduce((a, b) => a + b, 0);
  let centres = [lab[argmin(weight.map((v) => -v))]!];
  while (centres.length < Math.min(lab.length, Math.max(16, 3 * maxColors))) {
    const scores = lab.map((c, i) => weight[i]! * Math.min(...centres.map((p) => squared(c, p))));
    const pick = argmin(scores.map((v) => -v));
    if (scores[pick]! <= 0) break;
    centres.push(lab[pick]!);
  }
  centres = lloyd(lab, weight, centres);
  for (let round = 0; round < 3; round++) {
    const current = cluster(lab, weight, centres),
      merged = merge(current.centres, current.mass, maxColors, min);
    if (merged.length === centres.length) break;
    centres = lloyd(lab, weight, merged);
    if (round === 2) {
      const final = cluster(lab, weight, centres);
      centres = merge(final.centres, final.mass, maxColors, min);
    }
  }
  const labels = nearest(lab, centres);
  return Palette.fromLab(
    centres.map((centre, j) => {
      const members = lab.map((_, i) => i).filter((i) => labels[i] === j);
      if (!members.length) return centre;
      const mode = lab[members[argmin(members.map((i) => -weight[i]!))]!]!;
      const near = members.filter((i) => deltaE2000(lab[i]!, mode) < 10),
        total = near.reduce((s, i) => s + weight[i]!, 0);
      return [0, 1, 2].map(
        (k) => near.reduce((s, i) => s + lab[i]![k]! * weight[i]!, 0) / total,
      ) as Vec3;
    }),
  );
}
