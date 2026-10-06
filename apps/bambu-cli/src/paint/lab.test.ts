import { describe, expect, it } from "vite-plus/test";
import {
  deltaE2000,
  labToSrgb,
  linearToSrgb,
  parseHex,
  srgbToLab,
  srgbToLinear,
  toHex,
  type Vec3,
} from "./lab.ts";
const pairs: [Vec3, Vec3, number][] = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[50, 2.5, 0], [61, -5, 29], 22.8977],
  [[50, 2.5, 0], [56, -27, -3], 31.903],
  [[50, 2.5, 0], [58, 24, 15], 19.4535],
  [[50, 2.5, 0], [50, 3.1736, 0.5854], 1],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];
describe("upstream colour maths", () => {
  it.each(pairs)("matches Sharma %j and %j", (a, b, expected) => {
    expect(Math.abs(deltaE2000(a, b) - expected)).toBeLessThan(1e-4);
    expect(deltaE2000(b, a)).toBeCloseTo(deltaE2000(a, b), 10);
  });
  const references: [string, Vec3][] = [
    ["#FF0000", [53.24, 80.09, 67.2]],
    ["#00FF00", [87.73, -86.18, 83.18]],
    ["#0000FF", [32.3, 79.19, -107.86]],
    ["#FFFFFF", [100, 0, 0]],
    ["#000000", [0, 0, 0]],
    ["#808080", [53.59, 0, 0]],
  ];
  it.each(references)("converts %s", (hex, lab) =>
    srgbToLab(parseHex(hex)).forEach((v, i) => expect(Math.abs(v - lab[i]!)).toBeLessThan(0.05)),
  );
  it("round trips the transfer curve and Lab", () => {
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404, 5);
    for (let i = 0; i < 500; i++) {
      const c: Vec3 = [(i % 256) / 255, ((i * 37) % 256) / 255, ((i * 79) % 256) / 255];
      labToSrgb(srgbToLab(c)).forEach((v, k) => expect(v).toBeCloseTo(c[k]!, 6));
      expect(linearToSrgb(srgbToLinear(i / 500))).toBeCloseTo(i / 500, 10);
    }
  });
  it("parses hex and rejects malformed colours", () => {
    expect(toHex(parseHex("#c81e1e"))).toBe("#C81E1E");
    expect(toHex(parseHex("7b7b7b"))).toBe("#7B7B7B");
    for (const bad of ["#12345", "red", "#GG0000", ""])
      expect(() => parseHex(bad)).toThrow("hex colour");
  });
});
