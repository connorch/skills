import { bounds, faceGeometry } from "./geometry.ts";
import type { Mesh } from "./geometry.ts";
import type { MaterialProfile, PrinterProfile } from "./hardware.ts";
import { diagnose } from "./topology.ts";
import type { MeshDiagnosis } from "./topology.ts";
import {
  checkBedContact,
  checkFit,
  checkFloating,
  checkMaterial,
  checkOverhangs,
  checkWallThickness,
  round,
} from "./checks.ts";
import type { CheckResult } from "./checks.ts";
export type Purpose = "general" | "decorative" | "functional";
export function meshCheck(d: MeshDiagnosis): CheckResult {
  if (d.watertight && d.winding_consistent && !d.inside_out)
    return { status: "pass", summary: "Watertight, with consistent outward-facing normals." };
  const problems = [
    d.boundary_edges ? `${d.boundary_edges} hole edges` : "",
    d.nonmanifold_edges ? `${d.nonmanifold_edges} non-manifold edges` : "",
    !d.winding_consistent ? "inconsistent face winding" : "",
    d.inside_out ? "inside out" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return d.watertight
    ? { status: "warn", summary: `Watertight, but ${problems}.` }
    : {
        status: "fail",
        summary: `Not watertight (${problems}); slicers may fill or drop parts of it.`,
      };
}
export function score({
  diagnosis,
  overhangs,
  thickness,
  bed_contact,
  floating,
  fit,
  material,
}: {
  diagnosis: MeshDiagnosis;
  overhangs: ReturnType<typeof checkOverhangs>;
  thickness: ReturnType<typeof checkWallThickness>;
  bed_contact: ReturnType<typeof checkBedContact>;
  floating: ReturnType<typeof checkFloating>;
  fit: ReturnType<typeof checkFit>;
  material: ReturnType<typeof checkMaterial>;
}) {
  const deductions = [
    {
      check: "overhangs",
      rule: "-1 per 5 % of the surface overhanging past the limit, at most -4",
      points: -Math.min(4, overhangs.area_pct / 5),
    },
    {
      check: "wall_thickness",
      rule: "-1 per 5 % of the surface thinner than the material's minimum wall, at most -4 (0 when not measured)",
      points: -Math.min(4, (thickness.thin_area_pct ?? 0) / 5),
    },
    {
      check: "bed_contact",
      rule: "-2 if it touches the plate only at a point or edge (< 1 mm2), -1 if the flat contact is under 5 % of the footprint",
      points: bed_contact.contact_mm2 < 1 ? -2 : bed_contact.contact_pct < 5 ? -1 : 0,
    },
    {
      check: "material",
      rule: "-3 if the printer cannot print the material (no enclosure, or hotend too cool)",
      points: material.status === "fail" ? -3 : 0,
    },
  ].map((d) => ({ ...d, points: round(d.points) + 0 }));
  const caps = [
    {
      check: "mesh",
      rule: "not watertight (after any repair)",
      limit: 4,
      applied: !diagnosis.watertight,
    },
    {
      check: "floating_parts",
      rule: "a body starts in mid-air",
      limit: 4,
      applied: floating.floating > 0,
    },
    {
      check: "build_volume",
      rule: "does not fit the printer",
      limit: 4,
      applied: fit.fits === false,
    },
  ];
  let value = 10 + deductions.reduce((sum, d) => sum + d.points, 0);
  for (const cap of caps) if (cap.applied) value = Math.min(value, cap.limit);
  return { value: round(Math.max(0, value)), rubric: { max: 10, deductions, caps } };
}
// Seven checks and their published rubric form one Printability Report.
export function analyze(
  mesh: Mesh,
  {
    material,
    printer,
    purpose = "general",
    overhang_limit_deg = 45,
  }: {
    material: MaterialProfile;
    printer: PrinterProfile | null;
    purpose?: Purpose;
    overhang_limit_deg?: number;
  },
) {
  const diagnosis = diagnose(mesh),
    overhangs = checkOverhangs(mesh, overhang_limit_deg),
    thickness = checkWallThickness(mesh, diagnosis, material.min_wall_mm),
    bed_contact = checkBedContact(mesh),
    floating = checkFloating(mesh),
    fit = checkFit(bounds(mesh).extents, printer),
    materialFit = checkMaterial(material, printer),
    geometryFacts = faceGeometry(mesh);
  const geometry = {
    dimensions_mm: bounds(mesh).extents.map((v) => round(v, 2)),
    volume_cm3:
      diagnosis.watertight && diagnosis.winding_consistent
        ? round(Math.abs(geometryFacts.volume) / 1000, 2)
        : null,
    surface_area_cm2: round(geometryFacts.area / 100, 2),
    triangles: diagnosis.faces,
    bodies: diagnosis.bodies,
  };
  const checks = [
    { id: "mesh", name: "Mesh", ...meshCheck(diagnosis) },
    { id: "build_volume", name: "Build volume", ...fit },
    { id: "floating_parts", name: "Floating parts", ...floating },
    { id: "overhangs", name: "Overhangs", ...overhangs },
    { id: "wall_thickness", name: "Wall thickness", ...thickness },
    { id: "bed_contact", name: "Bed contact", ...bed_contact },
    { id: "material", name: "Material", ...materialFit },
  ];
  const result = score({
      diagnosis,
      overhangs,
      thickness,
      bed_contact,
      floating,
      fit,
      material: materialFit,
    }),
    largest = Math.max(...geometry.dimensions_mm),
    [x, y, z] = geometry.dimensions_mm,
    narrowest = Math.min(x!, y!),
    suggestions: string[] = [];
  if (z! >= Math.max(x!, y!) && narrowest > 0 && z! / narrowest > 5)
    suggestions.push(
      `Tall and slender (${(z! / narrowest).toFixed(0)}x taller than its narrowest side): it is weakest across its layer lines, so print it lying down if it has to carry load.`,
    );
  if (geometry.triangles > 500000)
    suggestions.push(
      `${geometry.triangles.toLocaleString("en-US")} triangles: if Bambu Studio is slow, simplify it there (right-click the model, Simplify Model).`,
    );
  if (purpose === "functional")
    suggestions.push(
      "Functional part: use 4 walls, and leave about 0.2 mm clearance where parts fit together.",
    );
  return {
    geometry,
    mesh: diagnosis,
    checks,
    score: result.value,
    score_rubric: result.rubric,
    issues: checks.filter((c) => c.status === "fail").map((c) => c.summary),
    warnings: checks.filter((c) => c.status === "warn").map((c) => c.summary),
    suggestions,
    print_settings: {
      layer_height:
        largest < 30
          ? "0.12 mm (small model, finer detail)"
          : largest > 200
            ? "0.28 mm (large model, faster)"
            : "0.20 mm",
      infill:
        purpose === "general"
          ? "15-30 % (depends on what the part is for)"
          : `${purpose === "functional" ? material.infill_functional_pct : material.infill_decorative_pct} %`,
      walls: purpose === "functional" ? ">= 4" : ">= 3",
      top_layers: ">= 5",
      nozzle_temp: `${material.nozzle_min_c}-${material.nozzle_max_c} C`,
      bed_temp: `${material.bed_c} C`,
      supports: overhangs.status === "pass" ? "likely not needed" : "needed for the overhangs",
    },
  };
}
