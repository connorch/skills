import { describe, expect, it } from "vite-plus/test";
import { holePositions } from "./kit.ts";

// Upstream's bolt-circle regressions need no WASM initialization or filesystem.
describe("hole centres", () => {
  it.each([2, 3, 5, 6, 8])("keeps %i neighbouring holes spacing mm apart", (count) => {
    const positions = holePositions(100, 100, count, 20);
    expect(positions).toHaveLength(count);
    const distances = positions.flatMap(([x, y], i) =>
      positions.slice(i + 1).map(([xx, yy]) => Math.hypot(xx - x, yy - y)),
    );
    expect(Math.min(...distances)).toBeCloseTo(20, 8);
    expect(positions.reduce((sum, [x]) => sum + x, 0) / count).toBeCloseTo(50, 8);
    expect(positions.reduce((sum, [, y]) => sum + y, 0) / count).toBeCloseTo(50, 8);
  });
  it("centres one hole and lays four holes on a square", () => {
    expect(holePositions(60, 40, 1, 25)).toEqual([[30, 20]]);
    expect(holePositions(60, 40, 4, 25)).toEqual([
      [17.5, 7.5],
      [42.5, 7.5],
      [17.5, 32.5],
      [42.5, 32.5],
    ]);
  });
  it("rejects zero and fractional hole counts", () => {
    expect(() => holePositions(60, 40, 0, 25)).toThrow("at least 1");
    expect(() => holePositions(60, 40, 1.5, 25)).toThrow("integer");
  });
});
