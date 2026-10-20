// Nearest passing colour (spec 3.2): OKLCH, hue kept, smallest lightness change that passes against
// every background. Deterministic. Chroma is reduced only when no lightness passes at the current one.

import { contrastRatio, hexToOklch, oklchToHex } from "./color";

const L_STEP = 0.004;
const CHROMA_FACTORS = [1, 0.75, 0.5, 0.25, 0] as const;

const passesAll = (fg: string, backgrounds: readonly string[], min: number): boolean =>
  backgrounds.every((bg) => contrastRatio(fg, bg) >= min);

/**
 * Returns `colour` itself when it already passes, else the closest passing colour. With a single
 * background it always passes (black or white reaches >= 4.58:1, covering both 4.5 and 3). With several
 * backgrounds at opposite luminance extremes no colour may exist; the result is then best effort.
 */
export function suggestPassingColour(
  colour: string,
  backgrounds: readonly string[],
  min: number,
): string {
  const original = colour.toUpperCase();
  if (passesAll(original, backgrounds, min)) return original;
  const base = hexToOklch(original);
  for (const factor of CHROMA_FACTORS) {
    const c = base.c * factor;
    for (let step = 1; step * L_STEP <= 1; step += 1) {
      const d = step * L_STEP;
      // At equal distance try lighter first, then darker (deterministic order).
      for (const dir of [1, -1]) {
        const l = base.l + dir * d;
        if (l < 0 || l > 1) continue;
        const candidate = oklchToHex({ l, c, h: base.h });
        if (passesAll(candidate, backgrounds, min)) return candidate;
      }
    }
  }
  for (const extreme of ["#000000", "#FFFFFF"]) {
    if (passesAll(extreme, backgrounds, min)) return extreme;
  }
  /* c8 ignore next: unreachable for min <= 4.5 (see doc comment) */
  return "#000000";
}
