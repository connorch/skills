import type { Kit } from "../index.ts";

// A 30 mm wide L-bracket, with a mounting hole through each arm.
export default function makeBracket(kit: Kit) {
  return kit.bracket({ width: 30, height: 40, thickness: 3, holeDiameter: 3.2 });
}
