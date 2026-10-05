import catalogue from "./data/filaments.json" with { type: "json" };
import { deltaE2000, parseHex, srgbToLab } from "./lab.ts";
import { argmin } from "./palette.ts";
import { trayLabel, type Slot } from "../printer/report.ts";
export interface Filament {
  line: string;
  name: string;
  hex: string;
}
export function filamentCatalogue(finish = "opaque,matte"): Filament[] {
  const known = Object.keys(catalogue.finishes),
    allowed =
      finish.trim().toLowerCase() === "all"
        ? known
        : finish
            .split(",")
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean);
  if (!allowed.length || allowed.some((v) => !known.includes(v)))
    throw new RangeError(`--finish: choose from ${known.join(", ")} or all`);
  return catalogue.colors.filter((c) => {
    const line = catalogue.lines[c.line as keyof typeof catalogue.lines];
    return (
      !line.support &&
      line.material === "PLA" &&
      c.pattern === "solid" &&
      allowed.includes(c.finish)
    );
  });
}
export function nearestFilaments(colours: string[], entries: Filament[] = filamentCatalogue()) {
  const candidates = entries.filter((f) => !f.line.toLowerCase().includes("translucent")),
    labs = candidates.map((f) => srgbToLab(parseHex(f.hex)));
  return colours.map((c) => {
    if (!candidates.length) return undefined;
    const distances = labs.map((l) => deltaE2000(srgbToLab(parseHex(c)), l)),
      best = argmin(distances);
    return { ...candidates[best]!, delta_e: Math.round(distances[best]! * 10) / 10 };
  });
}
export function nearestSlots(colours: string[], slots: Slot[]) {
  const candidates = slots.filter((s) => s.color),
    labs = candidates.map((s) => srgbToLab(parseHex(s.color)));
  return colours.map((c) => {
    if (!candidates.length) return undefined;
    const distances = labs.map((l) => deltaE2000(srgbToLab(parseHex(c)), l)),
      best = argmin(distances),
      slot = candidates[best]!;
    return {
      slot: { label: trayLabel(slot), name: slot.name, material: slot.material, hex: slot.color },
      delta_e: Math.round(distances[best]! * 10) / 10,
    };
  });
}
