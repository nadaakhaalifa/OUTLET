// PLACEHOLDER ART KIT: pure generators for store covers and campaign heroes (no RN imports).
// Brand colours come from ./palette (tokens). The hero stop literals below are deliberately artistic and not tokens.
import { hashSeed, paletteFor, rng, type ArtPalette, WHITE, BLACK, INK, DEEP, PAPER, SAND, SAGE, TEAL, FOREST } from "./palette";

export interface ArtLayer {
  readonly d: string;
  readonly fill: string;
  readonly opacity: number;
  readonly stroke?: number;
}

export const COVER_W = 400;
export const COVER_H = 160;
export const COVER_VARIANTS = ["arches", "stripes", "lattice", "sun"] as const;
export type CoverVariant = (typeof COVER_VARIANTS)[number];

export function coverVariant(seed: string | number): CoverVariant {
  const v = COVER_VARIANTS[(hashSeed(`cover:${seed}`) >>> 3) % COVER_VARIANTS.length];
  return v ?? "arches";
}

export function starPath(cx: number, cy: number, outer: number, inner: number, points: number): string {
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / points - Math.PI / 2;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

export function coverLayers(seed: string | number): { palette: ArtPalette; variant: CoverVariant; layers: ArtLayer[] } {
  const palette = paletteFor(seed);
  const variant = coverVariant(seed);
  const r = rng(`cover-layout:${seed}`);
  const layers: ArtLayer[] = [];
  if (variant === "arches") {
    const w = 56;
    const off = Math.floor(r() * 20);
    for (let i = -1; i < 8; i++) {
      const x = i * w + off;
      const row = i % 2 === 0;
      layers.push({ d: `M${x} ${COVER_H}V86A${w / 2} ${w / 2} 0 0 1 ${x + w} 86V${COVER_H}Z`, fill: row ? palette.deep : palette.accent, opacity: row ? 0.38 : 0.28 });
      layers.push({ d: `M${x + 11} ${COVER_H}V92A${(w - 22) / 2} ${(w - 22) / 2} 0 0 1 ${x + w - 11} 92V${COVER_H}Z`, fill: BLACK, opacity: 0.12 });
    }
  } else if (variant === "stripes") {
    const sw = 28 + Math.floor(r() * 14);
    for (let i = -4; i < 14; i++) {
      const x = i * sw * 1.6;
      layers.push({ d: `M${x} ${COVER_H}L${x + 90} 0H${x + 90 + sw}L${x + sw} ${COVER_H}Z`, fill: i % 3 === 0 ? palette.accent : palette.deep, opacity: i % 3 === 0 ? 0.42 : 0.3 });
    }
  } else if (variant === "lattice") {
    const s = 40;
    for (let row = 0; row < 5; row++) {
      for (let col = -1; col < 11; col++) {
        const cx = col * s + (row % 2 === 0 ? 0 : s / 2);
        const cy = row * (s / 2);
        layers.push({ d: `M${cx} ${cy - s / 2}L${cx + s / 2} ${cy}L${cx} ${cy + s / 2}L${cx - s / 2} ${cy}Z`, fill: (row + col) % 2 === 0 ? palette.deep : palette.accent, opacity: (row + col) % 2 === 0 ? 0.3 : 0.2, stroke: 1 });
        if ((row + col) % 3 === 0) layers.push({ d: starPath(cx, cy, s * 0.2, s * 0.09, 8), fill: WHITE, opacity: 0.35 });
      }
    }
  } else {
    const cx = 120 + Math.floor(r() * 160);
    for (let i = 6; i >= 1; i--) {
      layers.push({ d: `M${cx - i * 26} ${COVER_H + 30}A${i * 26} ${i * 26} 0 0 1 ${cx + i * 26} ${COVER_H + 30}Z`, fill: i % 2 === 0 ? palette.deep : palette.accent, opacity: 0.16 + (6 - i) * 0.05 });
    }
    layers.push({ d: `M${cx - 26} ${COVER_H + 30}A26 26 0 0 1 ${cx + 26} ${COVER_H + 30}Z`, fill: WHITE, opacity: 0.55 });
  }
  return { palette, variant, layers };
}

export const HERO_VARIANTS = ["drop", "sale", "plus", "ramadan", "eid", "tide", "atelier"] as const;
export type HeroVariant = (typeof HERO_VARIANTS)[number];
export const HERO_W = 400;
export const HERO_H = 240;

export interface HeroSpec {
  readonly stops: readonly [string, string, string];
  readonly layers: readonly ArtLayer[];
}

const SAND_SOFT = SAND;

function rays(cx: number, cy: number, n: number, len: number, spread: number, fill: string, opacity: number): ArtLayer[] {
  const out: ArtLayer[] = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n;
    const a2 = a + spread;
    out.push({ d: `M${cx} ${cy}L${(cx + len * Math.cos(a)).toFixed(1)} ${(cy + len * Math.sin(a)).toFixed(1)}L${(cx + len * Math.cos(a2)).toFixed(1)} ${(cy + len * Math.sin(a2)).toFixed(1)}Z`, fill, opacity });
  }
  return out;
}

function archRow(y: number, w: number, fill: string, opacity: number): ArtLayer[] {
  const out: ArtLayer[] = [];
  for (let x = -w / 2; x < HERO_W + w; x += w) {
    out.push({ d: `M${x} ${HERO_H}V${y}A${w / 2} ${w / 2} 0 0 1 ${x + w} ${y}V${HERO_H}Z`, fill, opacity });
  }
  return out;
}

/** Wave arcs: concentric curves that read as sea swell. */
function swell(n: number, fill: string, opacity: number): ArtLayer[] {
  return Array.from({ length: n }, (_, i): ArtLayer => ({ d: `M-40 ${70 + i * 34}C60 ${40 + i * 34} 140 ${100 + i * 34} 220 ${64 + i * 34}S360 ${50 + i * 34} 360 ${60 + i * 34}`, fill, opacity: opacity + i * 0.012, stroke: 1.2 }));
}

/** Filled wave band from `y` down to the bottom edge (layered to read as deep sea swell). */
function waveBand(y: number, amp: number, phase: number, fill: string, opacity: number): ArtLayer {
  const a = amp * phase;
  const b = amp * -phase;
  return { d: `M-20 ${y}C60 ${y - a} 130 ${y + a} 200 ${y}S340 ${y + b} 420 ${y - a}V${HERO_H}H-20Z`, fill, opacity };
}

/** Soft vertical linen fold: a tapered ribbon with a lit edge. */
function linenFold(x: number, w: number, fill: string, opacity: number): ArtLayer {
  return { d: `M${x} -10C${x + w * 0.9} 70 ${x - w * 0.5} 160 ${x + w * 0.3} ${HERO_H + 10}H${x + w * 1.3}C${x + w * 0.6} 150 ${x + w * 1.9} 70 ${x + w} -10Z`, fill, opacity };
}

export function heroSpec(variant: HeroVariant): HeroSpec {
  switch (variant) {
    case "drop": // teal sea seen from above
      return {
        stops: ["#06282B", "#0F4D4D", "#2A8079"],
        layers: [
          { d: `M-20 ${HERO_H}C60 120 120 150 200 100S320 40 340 60V${HERO_H}Z`, fill: INK, opacity: 0.28 },
          ...swell(5, "#E9DCC6", 0.1),
          { d: `M250 0H300L180 ${HERO_H}H130Z`, fill: WHITE, opacity: 0.05 },
          { d: "M232 96m-30 0a30 30 0 1 0 60 0a30 30 0 1 0 -60 0Z", fill: WHITE, opacity: 0.08 },
        ],
      };
    case "sale": // sand linen with soft folds
      return {
        stops: ["#EFE5D3", "#DDC7A6", "#B99A74"],
        layers: [
          ...[0, 1, 2, 3, 4, 5].map((i): ArtLayer => ({ d: `M${-30 + i * 62} 0C${10 + i * 62} 60 ${-20 + i * 62} 140 ${20 + i * 62} ${HERO_H}H${-40 + i * 62}C${-80 + i * 62} 140 ${-50 + i * 62} 60 ${-30 + i * 62} 0Z`, fill: "#7A5C3A", opacity: 0.08 })),
          { d: "M300 120m-120 0a120 120 0 1 0 240 0a120 120 0 1 0 -240 0Z", fill: WHITE, opacity: 0.18 },
        ],
      };
    case "plus": { // sage and forest arches
      return {
        stops: ["#102A24", FOREST, SAGE],
        layers: [
          ...archRow(130, 90, INK, 0.3),
          ...archRow(170, 90, DEEP, 0.34),
          { d: "M70 60m-34 0a34 34 0 1 0 68 0a34 34 0 1 0 -68 0Z", fill: SAND_SOFT, opacity: 0.35 },
        ],
      };
    }
    case "ramadan": {
      const dots: ArtLayer[] = [];
      const r = rng("ramadan-stars");
      for (let i = 0; i < 14; i++) dots.push({ d: starPath(r() * HERO_W, r() * 130, 4 + r() * 4, 1.6, 4), fill: PAPER, opacity: 0.45 + r() * 0.4 });
      return {
        stops: [DEEP, TEAL, FOREST],
        layers: [
          ...dots,
          { d: "M300 26A44 44 0 1 0 300 114A34 34 0 1 1 300 26Z", fill: SAND_SOFT, opacity: 0.95 },
          ...archRow(170, 70, "#041112", 0.5),
          ...archRow(196, 70, "#020B0C", 0.6),
        ],
      };
    }
    case "tide": // deeper teal sea: layered waves, foam lines, a low sun glint
      return {
        stops: ["#031C1F", "#0B3F40", "#1F6B66"],
        layers: [
          { d: "M290 60m-70 0a70 70 0 1 0 140 0a70 70 0 1 0 -140 0Z", fill: "#BFE3D8", opacity: 0.1 },
          { d: "M290 60m-34 0a34 34 0 1 0 68 0a34 34 0 1 0 -68 0Z", fill: "#E9DCC6", opacity: 0.16 },
          waveBand(70, 26, 1, "#14504F", 0.55),
          waveBand(108, 22, -1, "#0E4244", 0.62),
          waveBand(146, 24, 1, "#0A3335", 0.7),
          waveBand(184, 20, -1, "#06262A", 0.78),
          waveBand(214, 14, 1, "#031B1E", 0.85),
          ...[84, 122, 160, 198].map((y, i): ArtLayer => ({ d: `M-20 ${y}C60 ${y - 18} 130 ${y + 18} 200 ${y}S340 ${y - 18} 420 ${y - 8}`, fill: "#E9DCC6", opacity: 0.2 - i * 0.03, stroke: 1 })),
          { d: `M260 0H330L200 ${HERO_H}H120Z`, fill: WHITE, opacity: 0.04 },
        ],
      };
    case "atelier": // deep sand linen folds with sage arches and a sun disc
      return {
        stops: ["#CDB690", "#9A7A56", "#4A3A2B"],
        layers: [
          { d: "M250 70m-84 0a84 84 0 1 0 168 0a84 84 0 1 0 -168 0Z", fill: "#F1E4CB", opacity: 0.16 },
          ...[-20, 50, 120, 190, 260, 330].map((x, i): ArtLayer => linenFold(x, 48 + (i % 2) * 14, i % 2 === 0 ? "#2E2216" : "#F4E8D2", i % 2 === 0 ? 0.16 : 0.1)),
          ...archRow(150, 120, "#6F8A78", 0.34),
          ...archRow(184, 120, "#2F4A3E", 0.5),
          ...archRow(214, 120, "#13231D", 0.6),
        ],
      };
    case "eid":
      return {
        stops: ["#F7F2E8", "#E8D9BE", SAND],
        layers: [
          ...archRow(120, 80, "#8A6642", 0.16),
          ...archRow(160, 80, "#5C4630", 0.16),
          { d: starPath(300, 82, 46, 20, 8), fill: WHITE, opacity: 0.6 },
          { d: starPath(300, 82, 28, 12, 8), fill: "#8A6642", opacity: 0.35 },
          ...rays(300, 82, 16, 130, 0.08, WHITE, 0.1),
        ],
      };
  }
}

/** First letter (Arabic or Latin) of a store name, uppercased when Latin. */
export function initialOf(name: string): string {
  const ch = Array.from(name.trim())[0];
  return ch === undefined ? "?" : ch.toLocaleUpperCase();
}
