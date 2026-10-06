import type { Kit } from "../index.ts";

// Four M3 clearance holes on a 25 mm square, leaving at least 1 mm at the edges.
export default async function makePlate(kit: Kit) {
  return kit.plateWithHoles({ width: 60, depth: 40, holeSpacing: 25 });
}
