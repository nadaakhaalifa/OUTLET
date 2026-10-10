import { describe, expect, it } from "vitest";
import { colors, type ColorScheme } from "./index";

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("color tokens meet WCAG 2.2 AA (4.5:1 for text)", () => {
  const schemes: ColorScheme[] = ["light", "dark"];
  for (const scheme of schemes) {
    const c = colors[scheme];
    const pairs: [string, string, string][] = [
      ["textPrimary on background", c.textPrimary, c.background],
      ["textPrimary on surface", c.textPrimary, c.surface],
      ["textSecondary on background", c.textSecondary, c.background],
      ["textSecondary on surface", c.textSecondary, c.surface],
      ["onAccent on accent", c.onAccent, c.accent],
      ["onDanger on danger", c.onDanger, c.danger],
    ];
    for (const [name, fg, bg] of pairs) {
      it(`${scheme}: ${name}`, () => {
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
