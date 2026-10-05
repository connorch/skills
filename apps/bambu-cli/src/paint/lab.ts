// sRGB, D65 CIELAB and Sharma's CIEDE2000 colour difference.
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export const unitClip = (v: number) => Math.min(1, Math.max(0, v));
export const srgbToLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
export function linearToSrgb(value: number): number {
  const v = unitClip(value);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}
export function parseHex(text: string): Vec3 {
  const digits = text.trim().replace(/^#/, "");
  if (!/^[\da-f]{6}$/i.test(digits))
    throw new RangeError(`not a hex colour: ${text} (expected #RRGGBB)`);
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255) as Vec3;
}
// Python/numpy round ties to even.
export function roundEven(v: number): number {
  const low = Math.floor(v);
  return v - low === 0.5 ? low + (low % 2) : Math.round(v);
}
export function toHex(rgb: Vec3): string {
  return (
    "#" +
    rgb
      .map((v) =>
        roundEven(unitClip(v) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()
  );
}
export function srgbToLab(rgb: Vec3): Vec3 {
  const [r, g, b] = rgb.map(srgbToLinear);
  const xyz = [
    (0.4124564 * r! + 0.3575761 * g! + 0.1804375 * b!) / 0.95047,
    0.2126729 * r! + 0.7151522 * g! + 0.072175 * b!,
    (0.0193339 * r! + 0.119192 * g! + 0.9503041 * b!) / 1.08883,
  ];
  const [x, y, z] = xyz.map((v) =>
    v > 216 / 24389 ? Math.cbrt(v) : ((24389 / 27) * v + 16) / 116,
  );
  return [116 * y! - 16, 500 * (x! - y!), 200 * (y! - z!)];
}
export function labToSrgb([l, a, b]: Vec3): Vec3 {
  const y = (l + 16) / 116;
  const f = [y + a / 500, y, y - b / 200];
  const [x, yy, z] = f.map(
    (v, i) =>
      (v ** 3 > 216 / 24389 ? v ** 3 : (116 * v - 16) / (24389 / 27)) * [0.95047, 1, 1.08883][i]!,
  );
  return [
    3.2404548360214087 * x! - 1.5371388501025751 * yy! - 0.4985315468684809 * z!,
    -0.9692663898756537 * x! + 1.876010928842491 * yy! + 0.04155608234667354 * z!,
    0.05564341960421366 * x! - 0.20402585426769818 * yy! + 1.057225162457929 * z!,
  ].map(linearToSrgb) as Vec3;
}
export function deltaE2000([l1, a1, b1]: Vec3, [l2, a2, b2]: Vec3): number {
  const rad = Math.PI / 180,
    cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7)));
  const aa1 = (1 + g) * a1,
    aa2 = (1 + g) * a2,
    c1 = Math.hypot(aa1, b1),
    c2 = Math.hypot(aa2, b2);
  const h1 = (Math.atan2(b1, aa1) / rad + 360) % 360,
    h2 = (Math.atan2(b2, aa2) / rad + 360) % 360;
  let dh = h2 - h1;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  if (c1 * c2 === 0) dh = 0;
  const dl = l2 - l1,
    dc = c2 - c1,
    dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * rad);
  const lm = (l1 + l2) / 2,
    cp = (c1 + c2) / 2,
    sum = h1 + h2;
  const hp =
    c1 * c2 === 0
      ? sum
      : Math.abs(h1 - h2) <= 180
        ? sum / 2
        : sum < 360
          ? (sum + 360) / 2
          : (sum - 360) / 2;
  const t =
    1 -
    0.17 * Math.cos((hp - 30) * rad) +
    0.24 * Math.cos(2 * hp * rad) +
    0.32 * Math.cos((3 * hp + 6) * rad) -
    0.2 * Math.cos((4 * hp - 63) * rad);
  const sl = 1 + (0.015 * (lm - 50) ** 2) / Math.sqrt(20 + (lm - 50) ** 2),
    sc = 1 + 0.045 * cp,
    sh = 1 + 0.015 * cp * t;
  const rt =
    -Math.sin(60 * Math.exp(-(((hp - 275) / 25) ** 2)) * rad) *
    2 *
    Math.sqrt(cp ** 7 / (cp ** 7 + 25 ** 7));
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}
