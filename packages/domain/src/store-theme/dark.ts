// Dark scheme derivation (spec 2.4): OKLCH lightness inverted, hue kept, then every failing pair is
// fixed with the nearest-passing-colour solver. Pure and deterministic.

import { hexToOklch, oklchToHex } from "./color";
import { CONTRAST_PAIRS, checkPalette } from "./contrast";
import { suggestPassingColour } from "./suggest";
import type { HeroScrim, Palette, PaletteColours, PaletteRole } from "./types";
import { PALETTE_ROLES } from "./types";

const FG_ORDER: readonly PaletteRole[] = ["accent", "onAccent", "text", "textMuted", "border"];

const invert = (hex: string): string => {
  const c = hexToOklch(hex);
  return oklchToHex({ l: 1 - c.l, c: c.c, h: c.h });
};

export function deriveDarkPalette(light: Palette): Palette {
  const base: Record<PaletteRole, string> = { ...(light as PaletteColours) };
  for (const role of PALETTE_ROLES) base[role] = invert(light[role]);
  const scrim: HeroScrim = { hex: invert(light.heroScrim.hex), alpha: light.heroScrim.alpha };
  // Backgrounds stay as inverted; foregrounds are fixed against them, one role at a time in an
  // order that respects dependencies (accent is a background for onAccent). If a foreground cannot
  // satisfy both background and surface (they sit at opposite extremes), surface collapses onto
  // background, which always has a solution.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const fg of FG_ORDER) {
      const pairs = CONTRAST_PAIRS.filter((p) => p.fg === fg);
      const min = Math.max(...pairs.map((p) => p.min));
      base[fg] = suggestPassingColour(base[fg], pairs.map((p) => base[p.bg]), min);
    }
    if (checkPalette("dark", { ...base, heroScrim: scrim }).length === 0) break;
    base.surface = base.background;
  }
  return { ...base, heroScrim: scrim };
}

export function resolveDarkPalette(light: Palette, dark: Palette | null): Palette {
  return dark ?? deriveDarkPalette(light);
}
