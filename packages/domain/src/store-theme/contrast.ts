// WCAG 2.2 AA guard over every foreground/background role pair in both schemes (spec 3.1).
// Thresholds: 4.5:1 text, 3:1 large text and non-text UI (1.4.3, 1.4.11).

import { contrastRatio } from "./color";
import type { Palette, PaletteRole, ThemeDocument } from "./types";

export const TEXT_MIN_RATIO = 4.5;
export const UI_MIN_RATIO = 3;

export interface ContrastPair {
  readonly fg: PaletteRole;
  readonly bg: PaletteRole;
  readonly min: number;
  readonly wcag: "1.4.3" | "1.4.11";
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "text", bg: "background", min: TEXT_MIN_RATIO, wcag: "1.4.3" },
  { fg: "text", bg: "surface", min: TEXT_MIN_RATIO, wcag: "1.4.3" },
  { fg: "textMuted", bg: "background", min: TEXT_MIN_RATIO, wcag: "1.4.3" },
  { fg: "textMuted", bg: "surface", min: TEXT_MIN_RATIO, wcag: "1.4.3" },
  { fg: "onAccent", bg: "accent", min: TEXT_MIN_RATIO, wcag: "1.4.3" },
  { fg: "accent", bg: "background", min: UI_MIN_RATIO, wcag: "1.4.11" },
  { fg: "accent", bg: "surface", min: UI_MIN_RATIO, wcag: "1.4.11" },
  { fg: "border", bg: "background", min: UI_MIN_RATIO, wcag: "1.4.11" },
  { fg: "border", bg: "surface", min: UI_MIN_RATIO, wcag: "1.4.11" },
];

export type SchemeName = "light" | "dark";

export interface ContrastFailure {
  readonly scheme: SchemeName;
  readonly pair: ContrastPair;
  readonly ratio: number;
}

export function checkPalette(scheme: SchemeName, palette: Palette): ContrastFailure[] {
  const out: ContrastFailure[] = [];
  for (const pair of CONTRAST_PAIRS) {
    const ratio = contrastRatio(palette[pair.fg], palette[pair.bg]);
    if (ratio < pair.min) out.push({ scheme, pair, ratio });
  }
  return out;
}

/** Checks both schemes. `resolvedDark` is the explicit dark palette or the platform-derived one. */
export function checkTheme(theme: ThemeDocument, resolvedDark: Palette): ContrastFailure[] {
  return [...checkPalette("light", theme.light), ...checkPalette("dark", resolvedDark)];
}
