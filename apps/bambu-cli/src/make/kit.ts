import type { Manifold, ManifoldToplevel, Vec2 } from "manifold-3d";

export const SLIP_FIT_GAP_MM = 0.2;
export type ManifoldToolbox = ManifoldToplevel;

// Hole centres keep neighbouring holes spacing mm apart, centred on the Model.
export function holePositions(
  width: number,
  depth: number,
  holes: number,
  spacing: number,
): Vec2[] {
  if (!Number.isInteger(holes) || holes < 1)
    throw new Error("holes must be at least 1 (an integer)");
  const cx = width / 2,
    cy = depth / 2;
  if (holes === 1) return [[cx, cy]];
  if (holes === 2)
    return [
      [cx - spacing / 2, cy],
      [cx + spacing / 2, cy],
    ];
  if (holes === 4)
    return [
      [cx - spacing / 2, cy - spacing / 2],
      [cx + spacing / 2, cy - spacing / 2],
      [cx - spacing / 2, cy + spacing / 2],
      [cx + spacing / 2, cy + spacing / 2],
    ];
  const radius = spacing / (2 * Math.sin(Math.PI / holes));
  return Array.from({ length: holes }, (_, i): Vec2 => [
    cx + radius * Math.cos((2 * Math.PI * i) / holes),
    cy + radius * Math.sin((2 * Math.PI * i) / holes),
  ]);
}

// Helpers use millimetres and the upstream geometry; raw CSG is available on manifold.
export function createKit(manifold: ManifoldToolbox) {
  const { Manifold: M, CrossSection } = manifold;
  function box(w: number, d: number, h: number, { center = false } = {}) {
    return M.cube([w, d, h], center);
  }
  function cylinder({
    radius,
    height,
    radiusTop = radius,
    segments = 0,
    center = false,
  }: {
    radius: number;
    height: number;
    radiusTop?: number;
    segments?: number;
    center?: boolean;
  }) {
    return M.cylinder(height, radius, radiusTop, segments, center);
  }
  function sphere(radius: number, { segments = 0 } = {}) {
    return M.sphere(radius, segments);
  }
  function extrude(polygon: Vec2[], height: number) {
    const section = new CrossSection([polygon], "NonZero");
    try {
      return M.extrude(section, height);
    } finally {
      section.delete();
    }
  }
  function revolve(polygon: Vec2[], { segments = 0 } = {}) {
    const section = new CrossSection([polygon], "NonZero");
    try {
      return M.revolve(section, segments);
    } finally {
      section.delete();
    }
  }
  function bracket({
    width: w,
    height: h,
    thickness: t,
    depth = h,
    holeDiameter = 0,
    fillet = 0,
  }: {
    width: number;
    height: number;
    thickness: number;
    depth?: number;
    holeDiameter?: number;
    fillet?: number;
  }) {
    const d = depth || h;
    if (d <= t || h <= t) throw new Error("height and depth must be larger than thickness");
    let model = box(w, d, t).add(box(w, t, h));
    if (fillet > 0) {
      const r = Math.min(fillet, d - t, h - t);
      const block = box(w, r, r).translate([0, t, t]);
      const cut = cylinder({ height: w, radius: r })
        .rotate([0, 90, 0])
        .translate([0, t + r, t + r]);
      model = model.add(block.subtract(cut));
    }
    if (holeDiameter > 0) {
      const radius = holeDiameter / 2;
      const baseHole = cylinder({ height: t + 1, radius }).translate([
        w / 2,
        t + (d - t) / 2,
        -0.5,
      ]);
      const uprightHole = cylinder({ height: t + 1, radius })
        .rotate([-90, 0, 0])
        .translate([w / 2, -0.5, t + (h - t) / 2]);
      model = model.subtract(baseHole).subtract(uprightHole);
    }
    return model;
  }
  function plateWithHoles({
    width,
    depth,
    thickness = 3,
    holes = 4,
    holeDiameter = 3.2,
    holeSpacing,
  }: {
    width: number;
    depth: number;
    thickness?: number;
    holes?: number;
    holeDiameter?: number;
    holeSpacing: number;
  }) {
    const positions = holePositions(width, depth, holes, holeSpacing);
    const radius = holeDiameter / 2,
      edge = radius + 1;
    for (const [x, y] of positions) {
      if (!(edge <= x && x <= width - edge && edge <= y && y <= depth - edge))
        throw new Error(
          `A hole at (${x.toFixed(1)}, ${y.toFixed(1)}) would cut the plate edge. Reduce holeSpacing or enlarge the plate.`,
        );
    }
    let model = box(width, depth, thickness);
    for (const [x, y] of positions)
      model = model.subtract(
        cylinder({ height: thickness + 1, radius, segments: 64 }).translate([x, y, -0.5]),
      );
    return model;
  }
  function enclosure({
    width: w,
    depth: d,
    height: h,
    wall = 2,
    lid = false,
  }: {
    width: number;
    depth: number;
    height: number;
    wall?: number;
    lid?: boolean;
  }) {
    const body = box(w, d, h).subtract(
      box(w - 2 * wall, d - 2 * wall, h - wall).translate([wall, wall, wall]),
    );
    if (!lid) return body;
    const gap = SLIP_FIT_GAP_MM,
      rimH = Math.min(3, h - wall - 1),
      rimW = w - 2 * wall - 2 * gap,
      rimD = d - 2 * wall - 2 * gap;
    if (rimH <= 0 || rimW <= 2 * wall || rimD <= 2 * wall)
      throw new Error("The enclosure is too small for a plug-in lid; drop lid or make it larger");
    const rim = box(rimW, rimD, rimH).subtract(
      box(rimW - 2 * wall, rimD - 2 * wall, rimH).translate([wall, wall, 0]),
    );
    const cover = box(w, d, wall)
      .add(rim.translate([wall + gap, wall + gap, wall]))
      .translate([w + 5, 0, 0]);
    return body.add(cover);
  }
  function hull(models: Manifold[]) {
    return M.hull(models);
  }
  function compose(models: Manifold[]) {
    return M.compose(models);
  }
  return {
    manifold,
    box,
    cylinder,
    sphere,
    extrude,
    revolve,
    bracket,
    plateWithHoles,
    enclosure,
    hull,
    compose,
  };
}

// Scripts can import type { Kit } from "/tmp/port/make/apps/bambu-cli/src/make/index.ts".
export type Kit = ReturnType<typeof createKit>;
