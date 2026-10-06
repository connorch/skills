import { bounds, faceGeometry, mul, sampleSurface, triangle } from "./geometry.ts";
import type { Mesh, Vec3 } from "./geometry.ts";
import { connectedComponents, diagnose } from "./topology.ts";
import type { MaterialProfile, PrinterProfile } from "./hardware.ts";
import { materialBelow, RayCaster } from "./rays.ts";
export type Status = "pass" | "warn" | "fail" | "skipped";
export interface CheckResult {
  status: Status;
  summary: string;
}
// Python rounds exact halfway values to even, including the rubric's 0.1-point lines.
export function round(value: number, digits = 1): number {
  if (!Number.isFinite(value)) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0),
    exponent = Number((bits >> 52n) & 0x7ffn);
  let numerator = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1075;
  numerator *= 10n ** BigInt(digits);
  const denominator = shift < 0 ? 1n << BigInt(-shift) : 1n;
  if (shift > 0) numerator <<= BigInt(shift);
  const quotient = numerator / denominator,
    remainder = numerator % denominator;
  const increment =
    remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n !== 0n);
  return (Number(quotient + (increment ? 1n : 0n)) / 10 ** digits) * Math.sign(value);
}
function check(status: Status, summary: string): CheckResult {
  return { status, summary };
}
export function checkOverhangs(mesh: Mesh, limit = 45) {
  const { areas, normals, area: total } = faceGeometry(mesh),
    plate = bounds(mesh).min[2];
  let area = 0;
  for (let f = 0; f < areas.length; f++)
    if (
      normals[f]![2] < -Math.sin((limit * Math.PI) / 180) &&
      Math.max(...triangle(mesh, f).map((p) => p[2])) - plate >= 0.1
    )
      area += areas[f]!;
  const pct = total ? round((area / total) * 100) : 0,
    status: Status = pct > 20 ? "fail" : pct > 5 ? "warn" : "pass";
  let summary =
    area > 0
      ? `${pct} % of the surface (${(area / 100).toFixed(1)} cm2) overhangs more than ${limit} deg from vertical.`
      : `No surface overhangs more than ${limit} deg from vertical.`;
  if (status === "fail") summary += " Needs supports or a different orientation.";
  if (status === "warn") summary += " Probably needs supports (tree supports work well).";
  return { ...check(status, summary), limit_deg: limit, area_mm2: round(area), area_pct: pct };
}
export function checkBedContact(mesh: Mesh) {
  const { areas, normals } = faceGeometry(mesh),
    { min, extents } = bounds(mesh);
  let contact = 0;
  for (let f = 0; f < areas.length; f++)
    if (
      normals[f]![2] < -Math.cos((5 * Math.PI) / 180) &&
      Math.max(...triangle(mesh, f).map((p) => p[2])) - min[2] < 0.1
    )
      contact += areas[f]!;
  const footprint = extents[0] * extents[1],
    pct = footprint ? round((contact / footprint) * 100) : 0;
  const summary =
    contact < 1
      ? "Touches the plate only at a point or an edge: add a brim or supports, or reorient."
      : `${contact.toFixed(0)} mm2 lies flat on the plate (${pct} % of the footprint).${pct < 5 ? " Small base: consider a brim." : ""}`;
  return {
    ...check(contact < 1 || pct < 5 ? "warn" : "pass", summary),
    contact_mm2: round(contact),
    footprint_mm2: round(footprint),
    contact_pct: pct,
  };
}
export function checkFloating(mesh: Mesh) {
  const { count, labels } = connectedComponents(mesh),
    plate = bounds(mesh).min[2],
    bodies = Array.from({ length: count }, () => [] as number[]);
  for (let f = 0; f < labels.length; f++) bodies[labels[f]!]!.push(f);
  const gaps: number[] = [];
  let caster: RayCaster | undefined;
  for (const faces of bodies) {
    const triangles = faces.map((f) => triangle(mesh, f));
    let bottom = Infinity;
    for (const t of triangles) for (const p of t) bottom = Math.min(bottom, p[2]);
    if (bottom - plate <= 0.1) continue;
    const points: Vec3[] = [];
    for (const t of triangles)
      for (const p of t)
        if (p[2] <= bottom + 0.1 && points.length < 64) points.push([p[0], p[1], p[2] - 0.1]);
    const band = {
      ...mesh,
      indices: new Uint32Array(
        faces
          .filter((_, i) => triangles[i]!.some((p) => p[2] <= bottom + 0.1))
          .flatMap((f) => Array.from(mesh.indices.slice(f * 3, f * 3 + 3))),
      ),
    };
    for (const p of sampleSurface(band, 64).points)
      if (p[2] <= bottom + 0.1) points.push([p[0], p[1], p[2] - 0.1]);
    caster ??= new RayCaster(mesh);
    if (!materialBelow(mesh, points, caster).some((n) => n > 0)) gaps.push(bottom - plate);
  }
  const gap = gaps.length ? round(Math.min(...gaps), 2) : null;
  const summary = gaps.length
    ? `${gaps.length} of ${count} ${gaps.length === 1 ? "body starts" : "bodies start"} in mid-air (lowest ${gap!.toFixed(1)} mm above the plate, nothing under it). Remove them (--keep-main), connect them, or add supports.`
    : count === 1
      ? "One body, resting on the plate."
      : `All ${count} bodies rest on the plate or on other parts.`;
  return {
    ...check(gaps.length ? "fail" : "pass", summary),
    bodies: count,
    floating: gaps.length,
    lowest_floating_gap_mm: gap,
  };
}
export function checkFit(size: Vec3, printer: PrinterProfile | null) {
  if (!printer)
    return {
      ...check("skipped", "Unknown printer: build volume not checked."),
      usable_mm: null,
      fits: null,
      rotate_on_plate: false,
      max_scale_pct: null,
    };
  const usable = printer.usable_volume_mm,
    maxScale = (room: Vec3) =>
      Math.min(...size.flatMap((s, i) => (s > 0 ? [(room[i]! / s) * 100] : []))),
    straight = maxScale(usable),
    turned = maxScale([usable[1], usable[0], usable[2]]),
    best = Math.max(straight, turned),
    pct = Number.isFinite(best) ? Math.floor(best * 10) / 10 : null;
  const volume = `${usable.join(" x ")} mm usable, a safety margin inside the printer's spec`;
  const fits = best >= 100,
    rotate = fits && straight < 100;
  const over = size
    .flatMap((s, i) => (s > usable[i]! ? [`${"XYZ"[i]} ${s.toFixed(1)} mm > ${usable[i]} mm`] : []))
    .join(", ");
  const summary = fits
    ? `Fits the ${printer.name} (${volume})${rotate ? " when turned 90 deg on the plate" : ""}.`
    : `Too big for the ${printer.name}: ${over} (${volume}). Scale to at most ${pct} % or split the model.`;
  return {
    ...check(fits ? (rotate ? "warn" : "pass") : "fail", summary),
    usable_mm: usable,
    fits,
    rotate_on_plate: rotate,
    max_scale_pct: pct,
  };
}
export function checkMaterial(material: MaterialProfile, printer: PrinterProfile | null) {
  if (!printer)
    return {
      ...check("skipped", "Unknown printer: material compatibility not checked."),
      problems: [] as string[],
    };
  const problems: string[] = [];
  if (material.needs_enclosure && !printer.enclosed)
    problems.push(`${material.name} needs an enclosed printer; the ${printer.name} is open-frame`);
  if (material.nozzle_min_c > 300 && !printer.high_temp)
    problems.push(
      `${material.name} prints at ${material.nozzle_min_c}-${material.nozzle_max_c} C, hotter than the ${printer.name}'s hotend`,
    );
  // Hardware facts beyond upstream's check: a warning, since the print can
  // still run (an abrasive filament wears a stainless nozzle; a cold chamber
  // warps; a missing profile needs a hand-made one in Studio).
  const warnings: string[] = [];
  if (material.abrasive && printer.hardened_nozzle === false)
    warnings.push(`${material.name} is abrasive; fit a hardened-steel nozzle`);
  if (material.needs_heated_chamber && printer.heated_chamber === false)
    warnings.push(`${material.name} prints best in a heated chamber; the ${printer.name} has none`);
  if (material.printers && !material.printers.includes(printer.name))
    warnings.push(`Bambu Studio has no ${material.name} profile for the ${printer.name}`);
  const all = [...problems, ...warnings];
  return {
    ...check(
      problems.length ? "fail" : warnings.length ? "warn" : "pass",
      all.length ? all.join("; ") + "." : `${material.name} suits the ${printer.name}.`,
    ),
    problems: all,
  };
}
export function checkWallThickness(mesh: Mesh, diagnosis = diagnose(mesh), minWall = 0.9) {
  const base = {
    min_wall_mm: minWall,
    thin_area_pct: null as number | null,
    min_mm: null as number | null,
    p5_mm: null as number | null,
    samples: 0,
    max_measured_mm: 10,
  };
  if (!diagnosis.watertight || !diagnosis.winding_consistent || diagnosis.inside_out)
    return {
      ...check(
        "skipped",
        "Not measured: wall thickness needs a watertight mesh (see the mesh check).",
      ),
      ...base,
    };
  const { points, faces } = sampleSurface(mesh),
    { normals } = faceGeometry(mesh),
    caster = new RayCaster(mesh),
    distances = points
      .map((p, i) => Math.min(10, caster.firstExit(p, mul(normals[faces[i]!]!, -1), 10)))
      .sort((a, b) => a - b);
  if (!distances.length)
    return { ...check("skipped", "Not measured: the Model has no surface area."), ...base };
  const pct = round((distances.filter((d) => d < minWall).length / distances.length) * 100),
    min = round(distances[0]!, 2),
    rank = (distances.length - 1) * 0.05,
    lo = Math.floor(rank),
    p5 = round(distances[lo]! + (distances[Math.ceil(rank)]! - distances[lo]!) * (rank - lo), 2),
    status: Status = pct > 5 ? "fail" : pct > 1 ? "warn" : "pass";
  let summary =
    pct === 0
      ? `No wall thinner than ${minWall} mm found at 2000 points (95 % of the surface is at least ${p5} mm).`
      : `${pct} % of the surface is thinner than ${minWall} mm (thinnest ${min} mm, 95 % at least ${p5} mm).`;
  if (pct)
    summary +=
      status === "fail"
        ? " Thicken the walls or scale the model up; thin walls print weak or not at all."
        : status === "warn"
          ? " Usually edges or tips; check them in the preview."
          : " A small share, typically sharp edges or tips.";
  return {
    ...check(status, summary),
    ...base,
    thin_area_pct: pct,
    min_mm: min,
    p5_mm: p5,
    samples: points.length,
  };
}
