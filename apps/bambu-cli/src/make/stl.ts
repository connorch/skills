import type { Manifold } from "manifold-3d";

// Refuse invalid or empty Models before creating their binary STL.
export function summarize(model: Manifold) {
  const status = model.status();
  if (status !== "NoError") throw new Error(`Invalid geometry (${status}). Nothing was written.`);
  if (model.isEmpty())
    throw new Error(
      "The result is empty (no solid left). Check subtractions and polygon points. Nothing was written.",
    );
  const bounds = model.boundingBox();
  const bodies = model.decompose();
  const bodyCount = bodies.length;
  for (const body of bodies) body.delete();
  return {
    dimensions: bounds.max.map((value, i) => value - bounds.min[i]!),
    volume: model.volume(),
    surface_area: model.surfaceArea(),
    triangles: model.numTri(),
    vertices: model.numVert(),
    watertight: true,
    bodies: bodyCount,
  };
}

// STL stores one normal and three XYZ vertices per triangle, all little endian.
export function binaryStl(model: Manifold): Buffer {
  summarize(model);
  const mesh = model.getMesh();
  const count = mesh.triVerts.length / 3;
  const buffer = Buffer.alloc(84 + count * 50);
  buffer.write("bambu make - millimetres");
  buffer.writeUInt32LE(count, 80);
  for (let triangle = 0; triangle < count; triangle++) {
    const vertices = [0, 1, 2].map((corner) => {
      const index = mesh.triVerts[triangle * 3 + corner]! * mesh.numProp;
      return [
        mesh.vertProperties[index]!,
        mesh.vertProperties[index + 1]!,
        mesh.vertProperties[index + 2]!,
      ] as const;
    });
    const [a, b, c] = vertices;
    if (!a || !b || !c) throw new Error("Missing triangle vertices");
    const u = b.map((value, i) => value - a[i]!);
    const v = c.map((value, i) => value - a[i]!);
    const normal = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const length = Math.hypot(...normal);
    const values = [...normal.map((value) => (length ? value / length : 0)), ...a, ...b, ...c];
    values.forEach((value, i) => buffer.writeFloatLE(value, 84 + triangle * 50 + i * 4));
  }
  return buffer;
}
