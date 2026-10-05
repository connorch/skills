import { ProfileLibrary, number, strings, text, type Candidate } from "./profiles.ts";
export const PRINTER_FAMILIES: Record<string, string> = {
  "A1 Mini": "Bambu Lab A1 mini",
  A1: "Bambu Lab A1",
  A2L: "Bambu Lab A2L",
  P1P: "Bambu Lab P1P",
  P1S: "Bambu Lab P1S",
  P2S: "Bambu Lab P2S",
  X1C: "Bambu Lab X1 Carbon",
  X1E: "Bambu Lab X1E",
  X2D: "Bambu Lab X2D",
  H2C: "Bambu Lab H2C",
  H2S: "Bambu Lab H2S",
  H2D: "Bambu Lab H2D",
  "H2D Pro": "Bambu Lab H2D Pro",
};
export const QUALITIES = ["draft", "standard", "fine"] as const;
export type Quality = (typeof QUALITIES)[number];
export interface PrintRequest {
  printer: string;
  nozzle_mm?: number;
  material?: string;
  quality?: Quality;
  layer_height_mm?: number;
}
export class ResolveError extends Error {}
const squash = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const base = (name: string) => name.split(" @")[0] ?? name;
const label = (name: string) => base(name).split("mm ").at(-1) ?? name;
const same = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 0.001;
export function printerKey(name: string): string | undefined {
  return Object.entries(PRINTER_FAMILIES).find(([key, family]) =>
    [key, family, family.replace("Bambu Lab ", "")].some((value) => squash(value) === squash(name)),
  )?.[0];
}
export function machinesByNozzle(library: ProfileLibrary, family: string): Candidate[] {
  return library
    .instances("machine")
    .filter(([, profile]) => text(profile, "printer_model") === family)
    .sort((a, b) => Number(text(a[1], "printer_variant")) - Number(text(b[1], "printer_variant")));
}
export function findMachine(library: ProfileLibrary, family: string, nozzle: number): Candidate {
  const candidates = machinesByNozzle(library, family);
  if (!candidates.length)
    throw new ResolveError(
      `This Bambu Studio's profiles (version ${library.version || "unknown"}) have no ${family}. Update Bambu Studio.`,
    );
  const found = candidates.find(([, profile]) => same(number(profile, "printer_variant"), nozzle));
  if (!found)
    throw new ResolveError(
      `${family} has no ${nozzle} mm nozzle profile. Nozzles: ${candidates.map(([, p]) => text(p, "printer_variant")).join(", ")} mm`,
    );
  return found;
}
export function compatible(
  library: ProfileLibrary,
  kind: "process" | "filament",
  machine: string,
): Candidate[] {
  return library.instances(kind).filter(([, profile]) => {
    const printers = strings(profile, "compatible_printers");
    return !printers.length || printers.includes(machine);
  });
}
export function layerHeights(candidates: Candidate[]): number[] {
  return [
    ...new Set(
      candidates
        .map(([, p]) => number(p, "layer_height"))
        .filter((n): n is number => n !== undefined),
    ),
  ].sort((a, b) => a - b);
}
export function materialTypes(candidates: Candidate[]): string[] {
  return [...new Set(candidates.map(([, p]) => text(p, "filament_type")).filter(Boolean))].sort();
}
const preference = [
  "Standard",
  "Optimal",
  "Fine",
  "Draft",
  "Balanced Quality",
  "Extra Fine",
  "Extra Draft",
  "High Quality",
  "Balanced Strength",
  "Strength",
];
function bestProcess(candidates: Candidate[], defaultName: string, word: string): Candidate {
  const rank = (c: Candidate) => [
    Number(c[0] !== defaultName),
    Number(label(c[0]) !== word),
    preference.includes(label(c[0])) ? preference.indexOf(label(c[0])) : preference.length,
  ];
  const found = [...candidates].sort((a, b) => {
    const ar = rank(a),
      br = rank(b);
    for (let i = 0; i < ar.length; i++) {
      const delta = (ar[i] ?? 0) - (br[i] ?? 0);
      if (delta) return delta;
    }
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  })[0];
  if (!found) throw new ResolveError("No process profiles match");
  return found;
}
export function findProcess(
  library: ProfileLibrary,
  machine: Candidate,
  quality: Quality = "standard",
  height?: number,
): Candidate {
  const candidates = compatible(library, "process", machine[0]);
  if (!candidates.length)
    throw new ResolveError(`No process profiles are compatible with ${machine[0]}.`);
  const defaultName = text(machine[1], "default_print_profile");
  if (height !== undefined) {
    const matches = candidates.filter(([, p]) => same(number(p, "layer_height"), height));
    if (!matches.length)
      throw new ResolveError(
        `No ${height} mm process profile for ${machine[0]}. Layer heights: ${layerHeights(candidates).join(", ")} mm`,
      );
    return bestProcess(matches, defaultName, "Standard");
  }
  if (!QUALITIES.includes(quality))
    throw new ResolveError(`Unknown quality '${quality}'. Use one of: ${QUALITIES.join(", ")}`);
  const defaultCandidate = candidates.find(([name]) => name === defaultName);
  if (quality === "standard" && defaultCandidate) return defaultCandidate;
  const word = { draft: "Draft", standard: "Standard", fine: "Fine" }[quality];
  const matches = candidates.filter(([name]) => label(name) === word);
  const pool = matches.length ? matches : candidates;
  const target =
    { draft: 0.6, standard: 0.5, fine: 0.3 }[quality] *
    (number(machine[1], "printer_variant") || 0.4);
  const distance = (c: Candidate) => Math.abs((number(c[1], "layer_height") || 0) - target);
  const nearest = Math.min(...pool.map(distance));
  return bestProcess(
    pool.filter((c) => same(distance(c), nearest)),
    defaultName,
    word,
  );
}
export function findFilament(
  library: ProfileLibrary,
  machine: Candidate,
  material?: string,
): Candidate {
  const candidates = compatible(library, "filament", machine[0]);
  const defaults = strings(machine[1], "default_filament_profile");
  const defaultCandidate = candidates.find(([name]) => defaults.includes(name));
  if (material === undefined && defaultCandidate) return defaultCandidate;
  const wanted = (material ?? "PLA").trim().toLowerCase();
  const exact = candidates.find(([name]) => name.toLowerCase() === wanted);
  if (exact) return exact;
  const bases = candidates
    .filter(([name]) => base(name).toLowerCase() === wanted)
    .sort(
      (a, b) =>
        Number(!defaults.includes(a[0])) - Number(!defaults.includes(b[0])) ||
        (a[0] < b[0] ? -1 : 1),
    );
  if (bases[0]) return bases[0];
  const types = candidates.filter(([, p]) => text(p, "filament_type").toLowerCase() === wanted);
  if (defaultCandidate && types.includes(defaultCandidate)) return defaultCandidate;
  types.sort((a, b) => {
    const av = text(a[1], "filament_vendor");
    const bv = text(b[1], "filament_vendor");
    return (
      Number(av !== "Generic") - Number(bv !== "Generic") ||
      Number(av !== "Bambu Lab") - Number(bv !== "Bambu Lab") ||
      base(a[0]).length - base(b[0]).length ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );
  });
  if (types[0]) return types[0];
  throw new ResolveError(
    `No ${material ?? "PLA"} filament profile for ${machine[0]}. Materials: ${materialTypes(candidates).join(", ")}. Or pass a Bambu Studio filament name, e.g. 'Bambu PETG HF'.`,
  );
}
// Select presets through the compatibility graph, never through filename guesses.
export function resolveProfiles(library: ProfileLibrary, request: PrintRequest) {
  const family = PRINTER_FAMILIES[request.printer];
  if (!family)
    throw new ResolveError(
      `Unknown printer '${request.printer}'. Known: ${Object.keys(PRINTER_FAMILIES).join(", ")}`,
    );
  const machine = findMachine(library, family, request.nozzle_mm ?? 0.4);
  const process = findProcess(library, machine, request.quality, request.layer_height_mm);
  const filament = findFilament(library, machine, request.material);
  return {
    printer: request.printer,
    nozzle: text(machine[1], "printer_variant"),
    machine: machine[0],
    process: process[0],
    filament: filament[0],
    layer_height_mm: number(process[1], "layer_height") || 0,
    material: text(filament[1], "filament_type"),
    bed_type: library.has("machine_model", family)
      ? text(library.raw("machine_model", family), "default_bed_type")
      : "",
  };
}
export type ProfileChoice = ReturnType<typeof resolveProfiles>;
