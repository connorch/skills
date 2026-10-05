import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { z } from "zod";
export class EstimateError extends Error {}
export interface FilamentUse {
  slot: number;
  filament_id: string;
  grams: number;
}
export interface Estimate {
  print_time_s: number;
  filament_g: number;
  filaments: FilamentUse[];
  plates: number;
  source: string;
  warnings: string[];
}
const record = z.record(z.string(), z.unknown());
const list = z.array(z.unknown()).catch([]);
export function parseDuration(text: string): number {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)];
  if (!parts.length) throw new EstimateError(`not a duration: '${text}'`);
  const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  return parts.reduce((sum, part) => sum + Number(part[1]) * (units[part[2] ?? ""] ?? 0), 0);
}
export function combineEstimates(estimates: Estimate[], source = "gcode"): Estimate {
  const uses = new Map<number, FilamentUse>();
  for (const estimate of estimates)
    for (const use of estimate.filaments) {
      const prior = uses.get(use.slot);
      uses.set(use.slot, {
        ...use,
        grams: use.grams + (prior?.grams ?? 0),
        filament_id:
          source === "result.json" ? use.filament_id : prior?.filament_id || use.filament_id,
      });
    }
  const filaments = [...uses.values()].sort((a, b) => a.slot - b.slot);
  return {
    print_time_s: estimates.reduce((sum, e) => sum + e.print_time_s, 0),
    filament_g: filaments.reduce((sum, f) => sum + f.grams, 0),
    filaments,
    plates: estimates.reduce((sum, e) => sum + e.plates, 0),
    source,
    warnings: estimates.flatMap((e) => e.warnings),
  };
}
export function parseResultJson(document: unknown): Estimate {
  const parsed = record.safeParse(document);
  const plates = list.parse(parsed.success ? parsed.data.sliced_plates : undefined);
  if (!plates.length) throw new EstimateError("result.json lists no sliced plates");
  const estimates = plates.map((raw) => {
    const plate = record.catch({}).parse(raw);
    if (typeof plate.total_predication !== "number" || !Number.isFinite(plate.total_predication))
      throw new EstimateError("result.json has no total_predication for a plate");
    const filaments: FilamentUse[] = [];
    for (const raw of list.parse(plate.filaments)) {
      const item = record.catch({}).parse(raw);
      if (
        typeof item.id === "number" &&
        Number.isInteger(item.id) &&
        typeof item.total_used_g === "number"
      )
        filaments.push({
          slot: item.id,
          filament_id: typeof item.filament_id === "string" ? item.filament_id : "",
          grams: item.total_used_g,
        });
    }
    return {
      print_time_s: plate.total_predication,
      filament_g: 0,
      filaments,
      plates: 1,
      source: "result.json",
      warnings:
        typeof plate.warning_message === "string" && plate.warning_message.trim()
          ? [plate.warning_message.trim()]
          : [],
    };
  });
  return combineEstimates(estimates, "result.json");
}
export function parseGcodeHeader(lines: Iterable<string>): Estimate {
  let seconds: number | undefined;
  let weights: number[] = [];
  let ids: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/[\r\n]+$/, "");
    if (line.startsWith("; CONFIG_BLOCK_END")) break;
    const time = line.startsWith(";") ? /total estimated time:\s*([^;\n]+)/.exec(line) : null;
    const weight = /^; total filament weight \[g\]\s*:\s*(.+)$/.exec(line);
    const id = /^; filament_ids = (.*)$/.exec(line);
    if (time?.[1]) seconds = parseDuration(time[1]);
    else if (weight?.[1]) {
      weights = weight[1]
        .split(/[,;]/)
        .filter((w) => w.trim())
        .map(Number);
      if (weights.some((w) => !Number.isFinite(w)))
        throw new EstimateError("invalid filament weight in G-code header");
    } else if (id?.[1]) ids = id[1].split(/[,;]/).map((i) => i.trim());
  }
  if (seconds === undefined)
    throw new EstimateError("the G-code header has no total estimated time");
  const filaments = weights.map((grams, i) => ({ slot: i + 1, filament_id: ids[i] ?? "", grams }));
  return {
    print_time_s: seconds,
    filament_g: weights.reduce((a, b) => a + b, 0),
    filaments,
    plates: 1,
    source: "gcode",
    warnings: [],
  };
}
// A sliced 3MF must contain plate G-code, not merely a Model XML file.
export function plateGcodes(data: Uint8Array): Map<number, string> {
  try {
    const archive = unzipSync(data, {
      filter: (file) => /^Metadata\/plate_\d+\.gcode$/.test(file.name),
    });
    const plates = new Map<number, string>();
    for (const name of Object.keys(archive).sort()) {
      const bytes = archive[name];
      if (bytes) plates.set(Number(/plate_(\d+)/.exec(name)?.[1]), strFromU8(bytes));
    }
    if (!plates.size) throw new EstimateError("contains no plate G-code");
    return plates;
  } catch (error) {
    throw new EstimateError(`cannot read sliced 3MF: ${String(error)}`);
  }
}
export function estimateFrom3mf(path: string, read = readFileSync): Estimate {
  return combineEstimates(
    [...plateGcodes(read(path)).values()].map((g) => parseGcodeHeader(g.split("\n"))),
  );
}
