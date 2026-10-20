// Colour maths: hex parsing, WCAG 2.x relative luminance and contrast ratio, OKLCH conversion.

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHex(value: string): boolean {
  return HEX_RE.test(value);
}

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  if (!isHex(hex)) throw new RangeError("invalid hex colour");
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export function rgbToHex(rgb: Rgb): string {
  return (
    "#" +
    rgb
      .map((c) => Math.min(255, Math.max(0, Math.round(c))).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

const toLinear = (c8: number): number => {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number): number => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return v * 255;
};

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export interface Oklch {
  readonly l: number;
  readonly c: number;
  /** degrees, 0..360 */
  readonly h: number;
}

export function hexToOklch(hex: string): Oklch {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function oklchToLinearRgb(lch: Oklch): [number, number, number] {
  const hr = (lch.h * Math.PI) / 180;
  const A = lch.c * Math.cos(hr);
  const B = lch.c * Math.sin(hr);
  const l = (lch.l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (lch.l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (lch.l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const EPS = 1e-6;
const inGamut = (rgb: readonly number[]): boolean => rgb.every((v) => v >= -EPS && v <= 1 + EPS);

/** OKLCH to hex; chroma is reduced (hue and lightness kept) until the colour is inside sRGB. */
export function oklchToHex(lch: Oklch): string {
  const l = Math.min(1, Math.max(0, lch.l));
  let lo = 0;
  let hi = Math.max(0, lch.c);
  let rgb = oklchToLinearRgb({ l, c: hi, h: lch.h });
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinearRgb({ l, c: mid, h: lch.h }))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinearRgb({ l, c: lo, h: lch.h });
  }
  return rgbToHex([
    fromLinear(Math.min(1, Math.max(0, rgb[0]))),
    fromLinear(Math.min(1, Math.max(0, rgb[1]))),
    fromLinear(Math.min(1, Math.max(0, rgb[2]))),
  ]);
}
