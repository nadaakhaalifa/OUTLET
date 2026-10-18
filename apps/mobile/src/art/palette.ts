// PLACEHOLDER ART KIT: deterministic colour + geometry helpers. Pure TS, no RN imports.
import { brand } from "@outlet/ui-tokens";

// Brand constants come from @outlet/ui-tokens so the art never drifts from the identity.
export const INK = brand.ink;
/** Deep teal-black: dark-mode surfaces and the splash backdrop. */
export const DEEP = brand.deep;
export const PAPER = brand.ivory;
/** Brand teal: monogram dot and wordmark hyphen on paper. */
export const TEAL = brand.teal;
export const FOREST = brand.forest;
/** Sand: decorative hairlines, the monogram dot on dark, illustration accents. */
export const SAND = brand.sand;
export const SAGE = brand.sage;
/**
 * Neutral light and shade used for sheens, grain and shading overlays. Deliberately NOT brand colours: they are
 * applied with partial opacity so any palette stays legible. Documented art literals.
 */
export const WHITE = "#FFFFFF";
export const BLACK = "#000000";
/** Darkest art shade (below DEEP) for dark-tone floors; intentionally artistic. */
export const ABYSS = "#041112";
/** Deliberately artistic literals below (palette stand-ins, hero stops) are not brand tokens by design. */

export type ArtTone = "light" | "dark";
export type ArtRatio = "3:4" | "1:1" | "16:9";

export interface ArtPalette {
  readonly name: string;
  readonly base: string;
  readonly deep: string;
  readonly accent: string;
  readonly bgTop: string;
  readonly bgBottom: string;
}

/** Editorial stand-ins: teal sea, sand linen, sage, forest. Neutral light, never skin or product-accurate colour. */
export const PALETTES: readonly ArtPalette[] = [
  { name: "sea", base: "#1F5F5E", deep: "#0F3A3B", accent: "#E9DCC6", bgTop: "#E3EBE6", bgBottom: "#C5D6D0" },
  { name: "ink", base: "#14383A", deep: INK, accent: SAND, bgTop: "#E6E9E4", bgBottom: "#CCD5D0" },
  { name: "linen", base: "#E4D8C3", deep: "#BFAE8F", accent: FOREST, bgTop: "#F7F2E8", bgBottom: "#E8DFCC" },
  { name: "sand", base: SAND, deep: "#A98B66", accent: PAPER, bgTop: "#F2EADC", bgBottom: "#DFD0B9" },
  { name: "sage", base: SAGE, deep: "#4F7562", accent: PAPER, bgTop: "#E9EEE6", bgBottom: "#CFDACD" },
  { name: "forest", base: FOREST, deep: "#1B3A2F", accent: SAND, bgTop: "#E6ECE5", bgBottom: "#C9D5CA" },
  { name: "stone", base: "#A89A86", deep: "#75685A", accent: PAPER, bgTop: "#EFEAE2", bgBottom: "#D9D1C5" },
  { name: "camel", base: "#B68D63", deep: "#8A6642", accent: PAPER, bgTop: "#F1E9DC", bgBottom: "#DDCCB4" },
];

/** FNV-1a 32-bit hash of a string. */
export function hashSeed(seed: string | number): number {
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32) returning floats in [0,1). */
export function rng(seed: string | number): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function paletteFor(seed: string | number): ArtPalette {
  const p = PALETTES[hashSeed(seed) % PALETTES.length];
  return p ?? (PALETTES[0] as ArtPalette);
}

export function ratioValue(ratio: ArtRatio): number {
  switch (ratio) {
    case "3:4":
      return 3 / 4;
    case "1:1":
      return 1;
    case "16:9":
      return 16 / 9;
  }
}

/** ViewBox for a ratio, fixed width 300. */
export function viewBoxFor(ratio: ArtRatio): { width: number; height: number } {
  const width = 300;
  return { width, height: Math.round((width / ratioValue(ratio)) * 100) / 100 };
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear mix of two hex colours; t=0 gives a, t=1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

export const lighten = (c: string, t: number): string => mix(c, WHITE, t);
export const darken = (c: string, t: number): string => mix(c, BLACK, t);

/** Dark mode swaps the studio backdrop for a deep tone derived from the palette. */
export function backdropFor(p: ArtPalette, tone: ArtTone): { top: string; bottom: string; floor: string } {
  if (tone === "light") return { top: p.bgTop, bottom: p.bgBottom, floor: BLACK };
  return { top: mix(p.deep, DEEP, 0.8), bottom: mix(p.deep, ABYSS, 0.88), floor: BLACK };
}

/** Deterministic film grain: two compact path strings (light and dark specks) for one <Path> each. */
export function grainPaths(seed: string | number, w: number, h: number, count: number, size = 0.8): { light: string; dark: string } {
  const r = rng(`grain:${seed}`);
  let light = "";
  let dark = "";
  for (let i = 0; i < count; i++) {
    const x = (r() * w).toFixed(1);
    const y = (r() * h).toFixed(1);
    const sz = r() < 0.8 ? size : size * 1.7;
    const d = `M${x} ${y}h${sz}v${sz}h-${sz}z`;
    if (i % 2 === 0) light += d; else dark += d;
  }
  return { light, dark };
}
