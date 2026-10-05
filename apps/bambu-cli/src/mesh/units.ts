export const MM_PER_UNIT = { mm: 1, cm: 10, m: 1000, in: 25.4 } as const;
export type Unit = keyof typeof MM_PER_UNIT;
const declaredUnits: Record<string, [string, number]> = {
  micron: ["um", 0.001],
  millimeter: ["mm", 1],
  millimeters: ["mm", 1],
  centimeter: ["cm", 10],
  centimeters: ["cm", 10],
  meter: ["m", 1000],
  meters: ["m", 1000],
  inch: ["in", 25.4],
  inches: ["in", 25.4],
  foot: ["ft", 304.8],
  feet: ["ft", 304.8],
};
export interface UnitDecision {
  unit: string;
  scale: number;
  source: "flag" | "file" | "size" | "assumed";
  note: string;
  doubtful: boolean;
}
export function decideUnits(
  largest: number,
  { requested, declared }: { requested?: Unit; declared?: string } = {},
): UnitDecision {
  if (requested)
    return {
      unit: requested,
      scale: MM_PER_UNIT[requested],
      source: "flag",
      note: `Units: ${requested} (from --unit).`,
      doubtful: false,
    };
  const declaration = declared && declaredUnits[declared.toLowerCase()];
  if (declaration) {
    const [unit, scale] = declaration;
    return {
      unit,
      scale,
      source: "file",
      note: `Units: ${declared}, declared in the file${scale === 1 ? "" : `, converted to mm (x${scale})`}.`,
      doubtful: false,
    };
  }
  const size = Number(largest.toPrecision(3));
  if (largest > 0 && largest < 0.5)
    return {
      unit: "m",
      scale: 1000,
      source: "size",
      note: `Units: the model is only ${size} units across, too small to be millimetres, so it was read as metres (x1000). If that is wrong, pass --unit.`,
      doubtful: true,
    };
  if (largest < 10)
    return {
      unit: "mm",
      scale: 1,
      source: "assumed",
      note: `Units: assumed millimetres, which makes the model ${size} mm across. If it was exported in another unit, pass --unit cm|in|m, or --height.`,
      doubtful: true,
    };
  return {
    unit: "mm",
    scale: 1,
    source: "assumed",
    note: "Units: assumed millimetres (the file does not say).",
    doubtful: false,
  };
}
