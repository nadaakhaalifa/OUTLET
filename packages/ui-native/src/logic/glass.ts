import { colors as tokenColors, type ColorTokens } from "@outlet/ui-tokens";

export type GlassMode = "blur" | "solid";
export type GlassTint = "light" | "dark" | "default";

/** Blur only when supported and the user has not asked for reduced transparency. */
export function glassMode(i: { reduceTransparency: boolean; blurSupported: boolean }): GlassMode {
  return i.reduceTransparency || !i.blurSupported ? "solid" : "blur";
}

/** Same colour with alpha 0, for gradient end stops (`rgba(r,g,b,a)` or `#rrggbb`). */
export function fadeOut(color: string): string {
  const m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (m !== null) return `rgba(${m[1]},${m[2]},${m[3]},0)`;
  const h = /^#([0-9a-f]{6})/i.exec(color);
  if (h !== null && h[1] !== undefined) {
    const n = parseInt(h[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0)`;
  }
  return "rgba(0,0,0,0)";
}

export interface GlassStyle {
  readonly mode: GlassMode;
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly highlight: string;
  /** Diagonal sheen laid over the blur (lit from the top start corner). */
  readonly sheen: string;
  /** Soft inner shadow along the lower edge for depth. */
  readonly shade: string;
  /** Transparent end stops matching `sheen` and `shade`. */
  readonly sheenFade: string;
  readonly shadeFade: string;
  readonly blurIntensity: number;
  readonly blurTint: "systemChromeMaterialLight" | "systemChromeMaterialDark";
}

export function glassStyle(mode: GlassMode, isDark: boolean, c: ColorTokens, intensity: number): GlassStyle {
  return {
    mode,
    backgroundColor: mode === "solid" ? c.glassSolid : c.glassTint,
    borderColor: c.glassBorder,
    highlight: c.glassHighlight,
    sheen: c.glassSheen,
    shade: c.glassShade,
    sheenFade: c.glassSheenFade,
    shadeFade: fadeOut(c.glassShade),
    blurIntensity: intensity,
    blurTint: isDark ? "systemChromeMaterialDark" : "systemChromeMaterialLight",
  };
}

function withAlpha(color: string, alpha: number): string {
  return fadeOut(color).replace(/,0\)$/, `,${alpha})`);
}

/** Scrim alpha stops (top-to-bottom) for text over imagery; the bottom stop guarantees AA for white text. */
export const SCRIM_MAX_ALPHA = 0.55;
export function scrimStops(position: "bottom" | "top" | "both"): { colors: string[]; locations: number[] } {
  // Scrim base is the `scrim` token (black in both schemes); only its alpha varies.
  const base = tokenColors.light.scrim;
  const clear = fadeOut(base);
  const dark = withAlpha(base, SCRIM_MAX_ALPHA);
  // The lower stop is deeper and starts earlier: light (ivory/sand) art must still carry hairline serif titles in white.
  const deep = withAlpha(base, Math.min(0.72, SCRIM_MAX_ALPHA + 0.17));
  if (position === "bottom") return { colors: [clear, deep], locations: [0.2, 1] };
  if (position === "top") return { colors: [dark, clear], locations: [0, 0.65] };
  return { colors: [dark, clear, clear, deep], locations: [0, 0.25, 0.4, 1] };
}
