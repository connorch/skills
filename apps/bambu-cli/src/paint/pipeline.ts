import { loadColouredModel, type ColouredModel } from "./load.ts";
import { Palette, assign, binColours, selectPalette } from "./palette.ts";
import { sampleSurface } from "./sampling.ts";
import { faceAdjacency, faceAreas, fillUnlabelled, smooth, voteFaces, weld } from "./segment.ts";
import { bounds } from "./project.ts";
import { nearestSlots } from "./filaments.ts";
import type { Slot } from "../printer/report.ts";
export interface PaintOptions {
  maxColors?: number;
  minArea?: number;
  colors?: string[];
  height?: number;
  smooth?: number;
  slots?: Slot[];
}
export class ColorsLostError extends Error {
  constructor(
    readonly lost: string[],
    readonly kept: string[],
  ) {
    super(
      `${lost.join(", ")} would not be printed: no triangle is mostly that colour (the texture detail is finer than the mesh). Leave it out with --colors "${kept.join(",")}", or import the GLB into Bambu Studio 2.7+ directly and let it convert the texture`,
    );
  }
}
export function validateOptions(options: PaintOptions): void {
  const max = options.maxColors ?? 4,
    min = options.minArea ?? 0.002,
    passes = options.smooth ?? 1;
  if (!Number.isInteger(max) || max < 1 || max > 8)
    throw new RangeError("--max-colors must be between 1 and 8");
  if (!Number.isFinite(min) || min < 0 || min >= 1)
    throw new RangeError("--min-area is a fraction between 0 and 1");
  if (options.height !== undefined && (!Number.isFinite(options.height) || options.height <= 0))
    throw new RangeError("--height must be positive");
  if (!Number.isInteger(passes) || passes < 0) throw new RangeError("--smooth must be 0 or more");
  if (options.colors) Palette.fromHex(options.colors);
}
// Detect surface clusters before mapping them to loaded Slots; duplicate Slot matches share a filament.
export function paintModel(model: ColouredModel, options: PaintOptions = {}) {
  validateOptions(options);
  const samples = sampleSurface(model),
    bins = binColours(samples.rgb, samples.weight),
    forced = Boolean(options.colors),
    max = options.maxColors ?? 4;
  let palette = options.colors
    ? Palette.fromHex(options.colors)
    : selectPalette(bins, max, options.minArea ?? 0.002);
  let binLabels = assign(bins.lab, palette);
  let slotMatches = nearestSlots(palette.hex, options.slots ?? []);
  const usingSlots = !forced && slotMatches.some(Boolean);
  if (usingSlots) {
    const hexes = [...new Set(slotMatches.flatMap((m) => (m ? [m.slot.hex] : [])))];
    binLabels = binLabels.map((label) => hexes.indexOf(slotMatches[label]!.slot.hex));
    palette = Palette.fromHex(hexes);
    slotMatches = nearestSlots(hexes, options.slots ?? []);
  }
  const count = palette.rgb.length;
  const labels = voteFaces(
    samples.face,
    bins.ofSample.map((i) => binLabels[i]!),
    samples.weight,
    model.faces.length,
    count,
  );
  const mesh = weld(model.vertices, model.faces),
    pairs = faceAdjacency(mesh.faces);
  const final = smooth(
    fillUnlabelled(
      mesh.sourceFace.map((i) => labels[i]!),
      pairs,
      count,
    ),
    pairs,
    count,
    options.smooth ?? 1,
  );
  let vertices = mesh.vertices;
  const warnings = [...model.warnings, ...samples.warnings],
    size = bounds(vertices).size;
  if (options.height !== undefined) {
    if (size[2] <= 0)
      throw new RangeError("the model is flat (zero height); cannot scale it to a height");
    const scale = options.height / size[2];
    vertices = vertices.map((v) => [v[0] * scale, v[1] * scale, v[2] * scale]);
  } else if (Math.max(...size) < 5 || Math.max(...size) > 400)
    warnings.push(
      `the model is ${Math.max(...size).toFixed(1)} mm across, which looks like a unit mismatch; pass --height to set its printed height`,
    );
  const areas = faceAreas(vertices, mesh.faces),
    total = Math.max(
      areas.reduce((s, v) => s + v, 0),
      1e-12,
    ),
    share = Array<number>(count).fill(0);
  final.forEach((label, i) => (share[label]! += areas[i]! / total));
  const unused = palette.hex.filter((_, i) => share[i] === 0);
  if (unused.length && !forced && !usingSlots)
    throw new ColorsLostError(
      unused,
      palette.hex.filter((c) => !unused.includes(c)),
    );
  if (unused.length)
    warnings.push(`no triangle uses ${unused.join(", ")}; that filament stays unused`);
  if (count === 1)
    warnings.push("only one colour found: this model doesn't need multi-colour printing");
  return {
    vertices,
    faces: mesh.faces,
    labels: final,
    palette,
    areaShare: share,
    sizeMm: bounds(vertices).size,
    warnings,
    slotMatches,
  };
}
export async function colorize(path: string, options: PaintOptions = {}) {
  return paintModel(await loadColouredModel(path), options);
}
