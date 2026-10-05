import { beforeAll, describe, expect, it } from "vite-plus/test";
import { initializeKit, summarize } from "./index.ts";
import type { Kit } from "./index.ts";

let kit: Kit;
beforeAll(async () => {
  kit = await initializeKit();
});

// Numerical cases from test_parametric.py and test_parametric_fixes.py (no recorded fixtures).
describe("upstream Make geometry", () => {
  it("makes a box with exact dimensions, volume, area and centering", () => {
    expect(summarize(kit.box(30, 20, 10))).toMatchObject({
      dimensions: [30, 20, 10],
      volume: 6000,
      surface_area: 2200,
      triangles: 12,
      vertices: 8,
      watertight: true,
    });
    expect(kit.box(10, 10, 10, { center: true }).boundingBox()).toEqual({
      min: [-5, -5, -5],
      max: [5, 5, 5],
    });
  });
  it("makes cylinders, centered cylinders, cones and spheres", () => {
    expect(kit.cylinder({ radius: 5, height: 20, segments: 64 }).volume()).toBeCloseTo(
      32 * 25 * Math.sin((2 * Math.PI) / 64) * 20,
      5,
    );
    expect(kit.cylinder({ radius: 5, height: 20, center: true }).boundingBox().min[2]).toBe(-10);
    expect(kit.cylinder({ radius: 5, height: 20, radiusTop: 2 }).status()).toBe("NoError");
    expect(summarize(kit.sphere(10)).dimensions).toEqual([20, 20, 20]);
  });
  it("extrudes clockwise outlines with NonZero fill", () => {
    expect(
      kit
        .extrude(
          [
            [0, 0],
            [0, 10],
            [10, 10],
            [10, 0],
          ],
          5,
        )
        .volume(),
    ).toBeCloseTo(500, 6);
  });
  it("revolves either polygon winding", () => {
    const polygon: [number, number][] = [
      [0, 0],
      [5, 0],
      [5, 20],
      [0, 20],
    ];
    const expected = kit.cylinder({ radius: 5, height: 20, segments: 64 }).volume();
    expect(kit.revolve(polygon, { segments: 64 }).volume()).toBeCloseTo(expected, 5);
    expect(kit.revolve(polygon.toReversed(), { segments: 64 }).volume()).toBeCloseTo(expected, 5);
  });
  it("makes an L-bracket with holes through both arms and an additive fillet", () => {
    const options = { width: 30, height: 40, thickness: 3 };
    const solid = kit.bracket(options);
    expect(summarize(solid).dimensions).toEqual([30, 40, 40]);
    expect(solid.volume()).toBeCloseTo(6930, 5);
    expect(summarize(kit.bracket({ ...options, depth: 25 })).dimensions).toEqual([30, 25, 40]);
    const removed = solid.volume() - kit.bracket({ ...options, holeDiameter: 3.2 }).volume();
    expect(Math.abs(removed / (2 * Math.PI * 1.6 ** 2 * 3) - 1)).toBeLessThan(0.05);
    expect(kit.bracket({ ...options, fillet: 3 }).volume()).toBeGreaterThan(solid.volume());
    expect(() => kit.bracket({ ...options, depth: 3 })).toThrow("larger than thickness");
    expect(() => kit.bracket({ ...options, height: 3 })).toThrow("larger than thickness");
  });
  it("subtracts 64-sided clearance holes and protects plate edges", () => {
    const model = kit.plateWithHoles({ width: 60, depth: 40, holeSpacing: 25 });
    expect(summarize(model).dimensions).toEqual([60, 40, 3]);
    expect(model.volume()).toBeCloseTo(7200 - 4 * 3 * 32 * 1.6 ** 2 * Math.sin(Math.PI / 32), 5);
    expect(() => kit.plateWithHoles({ width: 30, depth: 30, holeSpacing: 40 })).toThrow("edge");
    expect(() => kit.plateWithHoles({ width: 60, depth: 40, holes: 0, holeSpacing: 25 })).toThrow(
      "at least 1",
    );
  });
  it("places the enclosure and slip-fit lid on the Plate", () => {
    const model = kit.enclosure({ width: 60, depth: 40, height: 30, lid: true });
    const bodies = model
      .decompose()
      .sort((a, b) => a.boundingBox().min[0] - b.boundingBox().min[0]);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.boundingBox().min[2]).toBe(0);
    expect(summarize(bodies[0]!).dimensions).toEqual([60, 40, 30]);
    const bounds = bodies[1]!.slice(3).bounds();
    expect(bounds.max[0] - bounds.min[0]).toBeCloseTo(55.6, 5);
    expect(bounds.max[1] - bounds.min[1]).toBeCloseTo(35.6, 5);
    expect((bounds.max[0] + bounds.min[0]) / 2).toBeCloseTo(95, 5);
    expect((bounds.max[1] + bounds.min[1]) / 2).toBeCloseTo(20, 5);
    expect(() => kit.enclosure({ width: 8, depth: 8, height: 3, lid: true })).toThrow("too small");
  });
  it("supports script CSG, hull and composition", () => {
    const base = kit.box(30, 30, 10);
    expect(
      base.subtract(kit.cylinder({ radius: 3, height: 15 }).translate([15, 15, 0])).volume(),
    ).toBeLessThan(base.volume());
    expect(base.intersect(kit.box(10, 10, 10)).volume()).toBeCloseTo(1000, 5);
    const boxes = [kit.box(10, 10, 10), kit.box(10, 10, 10).translate([20, 0, 0])];
    expect(kit.hull(boxes).volume()).toBeCloseTo(3000, 5);
    expect(summarize(kit.compose(boxes))).toMatchObject({ bodies: 2, volume: 2000 });
  });
});
