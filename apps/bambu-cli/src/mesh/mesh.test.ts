import { describe, expect, it } from "vite-plus/test";
import {
  box,
  cup,
  hollowSphere,
  lyingCup,
  missingTriangle,
  sheets,
  sphere,
  tShape,
  wedge,
} from "./test-shapes.ts";
import { bounds, merge, signedVolume, translate } from "./geometry.ts";
import { diagnose } from "./topology.ts";
import { keepLargestBody, repairMesh } from "./repair.ts";
import { orientForPrinting } from "./orient.ts";
import {
  round,
  checkBedContact,
  checkFit,
  checkFloating,
  checkMaterial,
  checkOverhangs,
  checkWallThickness,
} from "./checks.ts";
import { analyze } from "./report.ts";
import type { MaterialProfile, PrinterProfile } from "./hardware.ts";
const PLA: MaterialProfile = {
  name: "PLA",
  min_wall_mm: 1.2,
  nozzle_min_c: 190,
  nozzle_max_c: 220,
  bed_c: 60,
  infill_decorative_pct: 15,
  infill_functional_pct: 30,
  needs_enclosure: false,
};
const OPEN: PrinterProfile = {
  name: "Open",
  usable_volume_mm: [230, 230, 230],
  enclosed: false,
  high_temp: false,
};
const WIDE: PrinterProfile = {
  name: "Wide",
  usable_volume_mm: [300, 200, 200],
  enclosed: true,
  high_temp: false,
};
const run = (mesh: Parameters<typeof analyze>[0], purpose: "general" | "functional" = "general") =>
  analyze(mesh, { material: PLA, printer: OPEN, purpose });
describe("upstream topology and minor repair", () => {
  it("diagnoses closed, missing, inverted and non-manifold faces", () => {
    expect(diagnose(box())).toMatchObject({
      watertight: true,
      boundary_edges: 0,
      nonmanifold_edges: 0,
      repair_tier: "none",
    });
    expect(diagnose(missingTriangle())).toMatchObject({
      watertight: false,
      boundary_edges: 3,
      nonmanifold_edges: 0,
      repair_tier: "minor",
    });
    const inverted = box();
    inverted.indices.reverse();
    expect(diagnose(inverted)).toMatchObject({ inside_out: true, repair_tier: "minor" });
    const fin = box();
    expect(
      diagnose({
        ...fin,
        positions: new Float32Array([...fin.positions, 5, 5, 40]),
        indices: new Uint32Array([...fin.indices, 0, 2, 8]),
      }),
    ).toMatchObject({ nonmanifold_edges: 1, repair_tier: "major" });
  });
  it("fills a triangle without changing its input", () => {
    const broken = missingTriangle(),
      fixed = repairMesh(broken);
    expect(fixed.result.after.watertight).toBe(true);
    expect(signedVolume(fixed.mesh)).toBeCloseTo(27000);
    expect(broken.indices.length).toBe(33);
  });
  it("fixes inconsistent and inside-out winding", () => {
    const inverted = box();
    inverted.indices.reverse();
    expect(repairMesh(inverted).result.steps).toContain(
      "turned the inside-out mesh the right way round",
    );
    const inconsistent = box();
    [inconsistent.indices[1], inconsistent.indices[2]] = [
      inconsistent.indices[2]!,
      inconsistent.indices[1]!,
    ];
    expect(repairMesh(inconsistent).result.after.winding_consistent).toBe(true);
  });
  it("does not double open sheets", () => {
    const fixed = repairMesh(sheets());
    expect(fixed.changed).toBe(false);
    expect(fixed.result.after.nonmanifold_edges).toBe(0);
    expect(fixed.mesh.indices.length).toBe(12);
  });
  it("keeps only a dominant body, refusing equal bodies", () => {
    const kept = keepLargestBody(merge([box(40), box(2, 2, 2, [60, 0, 0])]));
    expect(kept.result).toMatchObject({ bodies: 2, removed: 1 });
    expect(bounds(kept.mesh).extents).toEqual([40, 40, 40]);
    expect(keepLargestBody(merge([box(20), box(20, 20, 20, [30, 0, 0])])).result.removed).toBe(0);
  });
});
describe("upstream print checks", () => {
  it.each([
    [40, false],
    [50, true],
    [60, true],
  ])("45-degree rule on %s-degree wedge", (angle, flagged) => {
    expect(checkOverhangs(wedge(Number(angle))).area_pct > 0).toBe(flagged);
  });
  it.each([
    [50, 42, false],
    [50, 60, true],
    [30, 40, true],
    [60, 50, false],
  ])("limit %s on wedge %s", (limit, angle, flagged) => {
    expect(checkOverhangs(wedge(Number(angle)), Number(limit)).area_pct > 0).toBe(flagged);
  });
  it("excludes plate faces but detects the T ceiling", () => {
    expect(checkOverhangs(box(40, 30, 5)).area_pct).toBe(0);
    expect(checkOverhangs(tShape()).area_mm2).toBe(600);
  });
  it("measures flat contact by area", () => {
    expect(checkBedContact(box(40, 20, 10))).toMatchObject({
      status: "pass",
      contact_mm2: 800,
      contact_pct: 100,
    });
    expect(checkBedContact(translate(sphere(10), [0, 0, 10])).status).toBe("warn");
  });
  it("fits with margins, rotation and unknown printers", () => {
    const result = checkFit([300, 50, 100], OPEN);
    expect(result.max_scale_pct).toBe(76.6);
    expect(result.summary).toContain("X 300.0 mm > 230 mm");
    expect(checkFit([150, 250, 100], WIDE)).toMatchObject({
      status: "warn",
      fits: true,
      rotate_on_plate: true,
    });
    expect(checkFit([500, 500, 500], null).status).toBe("skipped");
  });
  it("checks enclosure and hotend compatibility", () => {
    expect(checkMaterial({ ...PLA, name: "ABS", needs_enclosure: true }, OPEN).status).toBe("fail");
    expect(
      checkMaterial({ ...PLA, name: "HOT", nozzle_min_c: 330, nozzle_max_c: 350 }, WIDE).summary,
    ).toContain("hotter than");
  });
  it("finds true floating bodies, respecting cavities and stacks", () => {
    expect(checkFloating(merge([box(40), box(40, 40, 3, [50, 0, 0])])).floating).toBe(0);
    expect(checkFloating(tShape()).floating).toBe(0);
    expect(checkFloating(merge([box(20), box(5, 5, 5, [40, 40, 12])]))).toMatchObject({
      floating: 1,
      lowest_floating_gap_mm: 12,
    });
    expect(checkFloating(hollowSphere()).floating).toBe(0);
    expect(
      checkFloating(merge([hollowSphere(30, 2), translate(sphere(5), [0, 0, 30])])).floating,
    ).toBe(1);
  });
  it("measures shells rather than bounding boxes", () => {
    const thin = checkWallThickness(hollowSphere(), undefined, 1.2);
    expect(thin.status).toBe("fail");
    expect(thin.thin_area_pct).toBeGreaterThan(95);
    expect(thin.p5_mm).toBeCloseTo(0.6, 1);
    expect(checkWallThickness(hollowSphere(30, 3), undefined, 1.2).status).toBe("pass");
  });
  it("measures plates, caps solid blocks, skips open surfaces", () => {
    expect(checkWallThickness(box(60, 40, 0.8), undefined, 1.2)).toMatchObject({
      status: "fail",
      p5_mm: 0.8,
    });
    expect(checkWallThickness(box(50), undefined, 1.2)).toMatchObject({
      status: "pass",
      thin_area_pct: 0,
      min_mm: 10,
    });
    expect(checkWallThickness(sheets()).thin_area_pct).toBeNull();
  });
  it("handles 100k triangles within a few seconds", () => {
    const model = sphere(30, 256, 200),
      start = performance.now();
    expect(checkWallThickness(model, undefined, 1.2).status).toBe("pass");
    expect(performance.now() - start).toBeLessThan(5000);
  }, 10000);
});
describe("upstream resting poses", () => {
  it("keeps a designed cup upright", () => {
    const result = orientForPrinting(cup());
    expect(result.result.rotated).toBe(false);
    expect(bounds(result.mesh).extents[2]).toBeCloseTo(90);
  });
  it("stands a sideways cup on its floor", () => {
    const result = orientForPrinting(lyingCup());
    expect(result.result.rotated).toBe(true);
    expect(bounds(result.mesh).extents[2]).toBeCloseTo(90);
    expect(result.result.contact_after_mm2).toBeCloseTo(Math.PI * 400, -1);
    expect(bounds(result.mesh).min[2]).toBeCloseTo(0);
  });
  it("lays a T on a wide face and drops raised Models", () => {
    const result = orientForPrinting(tShape());
    expect(result.result).toMatchObject({
      rotated: true,
      contact_before_mm2: 100,
      contact_after_mm2: 600,
    });
    expect(checkOverhangs(result.mesh).area_pct).toBe(0);
    expect(orientForPrinting(box(20, 20, 5, [0, 0, 12])).result).toMatchObject({
      rotated: false,
      moved: true,
    });
  });
});
describe("upstream published score", () => {
  it("scores a clean cube at ten", () => expect(run(box(50)).score).toBe(10));
  it("caps open, oversized and floating Models at four", () => {
    for (const model of [
      sheets(),
      missingTriangle(),
      box(500),
      merge([box(30), box(5, 5, 5, [50, 50, 20])]),
    ])
      expect(run(model).score).toBeLessThanOrEqual(4);
  });
  it("grades heavy overhangs down and publishes additive deductions", () => {
    const report = run(wedge(60));
    expect(report.score).toBeLessThanOrEqual(6);
    expect(report.score).toBeCloseTo(
      10 + report.score_rubric.deductions.reduce((s, d) => s + d.points, 0),
    );
  });
  it("purpose changes settings, never score; JSON stays finite", () => {
    const general = run(box(50)),
      functional = run(box(50), "functional");
    expect(general.score_rubric).toEqual(functional.score_rubric);
    expect(general.print_settings.walls).not.toBe(functional.print_settings.walls);
    expect(general.checks).toHaveLength(7);
    expect(JSON.parse(JSON.stringify(run(sheets()))).geometry.volume_cm3).toBeNull();
  });
});
describe("upstream numeric rounding", () => {
  it("rounds halfway values to even and preserves binary float rounding", () => {
    expect(round(5.25)).toBe(5.2);
    expect(round(5.75)).toBe(5.8);
    expect(round(-2.5, 0)).toBe(-2);
    expect(round(2.675, 2)).toBe(2.67);
  });
});
