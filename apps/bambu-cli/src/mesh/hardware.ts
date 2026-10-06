import printerData from "./data/printers.json";
import materialData from "./data/materials.json";
import type { Vec3 } from "./geometry.ts";

export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^bambu\s*(lab)?\s*/, "")
    .replace(/[^a-z0-9+]/g, "");
}
export const printers = Object.entries(printerData.printers).map(([key, p]) => ({
  ...p,
  key,
  dual_nozzle_volume_mm: "dual_nozzle_volume_mm" in p ? p.dual_nozzle_volume_mm : null,
  extruders: "extruders" in p ? p.extruders : [],
  chamber_max_c: p.chamber.startsWith("heated") ? Number(p.chamber.match(/\d+/)?.[0]) : null,
  discontinued: p.status.startsWith("discontinued"),
}));
export type Printer = (typeof printers)[number];
export const materials = Object.entries(materialData.materials).map(([key, m]) => ({ ...m, key }));
export type Material = (typeof materials)[number];
export class UnknownHardwareError extends Error {}
export class UnsupportedMaterialError extends UnknownHardwareError {}
export function printer(name: string): Printer {
  const normalized = normalizeName(name),
    found = printers.find((p) =>
      [p.key, p.name, p.machine, ...p.aliases, ...p.model_ids].some(
        (n) => normalizeName(n) === normalized,
      ),
    );
  if (!found)
    throw new UnknownHardwareError(
      `Unknown printer '${name}'. Known printers: ${printers.map((p) => p.key).join(", ")}`,
    );
  return found;
}
export function material(name: string): Material {
  const normalized = normalizeName(name),
    found = materials.find((m) =>
      [m.key, ...m.aliases].some((n) => normalizeName(n) === normalized),
    );
  if (found) return found;
  for (const [bad, reason] of Object.entries(materialData.unsupported))
    if (normalizeName(bad) === normalized)
      throw new UnsupportedMaterialError(
        `${bad} can't be printed on a Bambu Lab printer: ${reason}`,
      );
  throw new UnknownHardwareError(
    `Unknown material '${name}'. Known materials: ${materials.map((m) => m.key).join(", ")}`,
  );
}
export function volumes(p: Printer): Record<string, number[]> {
  return {
    plate: p.build_volume_mm,
    ...Object.fromEntries(p.extruders.map((e) => [e.name, e.volume_mm])),
    ...(p.dual_nozzle_volume_mm ? { dual_nozzle: p.dual_nozzle_volume_mm } : {}),
  };
}
export function usableVolume(
  p: Printer,
  margin = 5,
  region = p.dual_nozzle_volume_mm ? "dual_nozzle" : "plate",
): Vec3 {
  const regions = volumes(p),
    volume = regions[region];
  if (!volume)
    throw new Error(
      `The ${p.name} has no '${region}' region; use one of ${Object.keys(regions).join(", ")}`,
    );
  if (margin < 0) throw new Error("margin_mm must not be negative");
  const usable: Vec3 = [volume[0]! - 2 * margin, volume[1]! - 2 * margin, volume[2]!];
  if (Math.min(...usable) <= 0)
    throw new Error(`A ${margin} mm margin leaves no room on the ${p.name}`);
  return usable;
}
export function materialIssues(p: Printer, m: Material): string[] {
  const issues: string[] = [],
    [low, high] = m.nozzle_c;
  if (low! > p.max_nozzle_c)
    issues.push(
      `${m.key} prints at ${low}-${high} °C; the ${p.name} nozzle reaches ${p.max_nozzle_c} °C.`,
    );
  if (m.needs_heated_chamber && p.chamber_max_c === null)
    issues.push(`${m.key} needs a heated chamber; the ${p.name} has none.`);
  else if (m.needs_enclosure && !p.enclosed)
    issues.push(`${m.key} needs an enclosed printer; the ${p.name} is open-frame.`);
  if (m.abrasive && p.nozzle !== "hardened_steel")
    issues.push(
      `${m.key} is abrasive: fit a hardened-steel nozzle (the ${p.name} ships with stainless steel).`,
    );
  if (!m.printers.includes(p.key))
    issues.push(`Bambu Studio has no ${m.key} profile for the ${p.name}.`);
  return issues;
}
export interface PrinterProfile {
  name: string;
  usable_volume_mm: Vec3;
  enclosed: boolean;
  high_temp: boolean;
  // Beyond upstream's profile: the facts the material check warns about.
  hardened_nozzle?: boolean;
  heated_chamber?: boolean;
}
export interface MaterialProfile {
  name: string;
  min_wall_mm: number;
  nozzle_min_c: number;
  nozzle_max_c: number;
  bed_c: number;
  infill_decorative_pct: number;
  infill_functional_pct: number;
  needs_enclosure: boolean;
  abrasive?: boolean;
  needs_heated_chamber?: boolean;
  // Printers Bambu Studio ships a profile for.
  printers?: string[];
}
export function printerProfile(p: Printer): PrinterProfile {
  return {
    name: p.key,
    usable_volume_mm: usableVolume(p),
    enclosed: p.enclosed,
    high_temp: p.max_nozzle_c > 300,
    hardened_nozzle: p.nozzle === "hardened_steel",
    heated_chamber: p.chamber_max_c !== null,
  };
}
export function materialProfile(m: Material, name = m.key): MaterialProfile {
  return {
    name,
    min_wall_mm: m.min_wall_mm,
    nozzle_min_c: m.nozzle_c[0]!,
    nozzle_max_c: m.nozzle_c[1]!,
    bed_c: m.bed_c,
    infill_decorative_pct: 15,
    infill_functional_pct: 30,
    needs_enclosure: m.needs_enclosure,
    abrasive: m.abrasive,
    needs_heated_chamber: m.needs_heated_chamber,
    printers: m.printers,
  };
}
