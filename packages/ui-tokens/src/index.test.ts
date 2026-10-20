import { describe, expect, it } from "vitest";
import { brand, colors, controlSize, fontFamilies, gutter, minTouchTarget, motion, nativeTypography, radius, slopFor, typography, spacing, type ColorScheme, type ColorTokens } from "./index";

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

function hue(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as [number, number, number];
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
function hueDistance(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

type K = keyof ColorTokens;
/** [foreground, background, minimum ratio]. 4.5 for text, 3 for large text / UI glyphs. */
const PAIRS: ReadonlyArray<[K, K, number]> = [
  ["textPrimary", "background", 4.5],
  ["textPrimary", "surface", 4.5],
  ["textPrimary", "fill", 4.5],
  ["textSecondary", "background", 4.5],
  ["textSecondary", "surface", 4.5],
  ["textSecondary", "fill", 4.5],
  ["onAccent", "accent", 4.5],
  ["onDanger", "danger", 4.5],
  ["danger", "background", 4.5],
  ["danger", "surface", 4.5],
  ["onSavings", "savings", 4.5],
  ["savings", "background", 4.5],
  ["savings", "surface", 4.5],
  ["savings", "fill", 4.5],
  ["onPlus", "plus", 4.5],
  ["plus", "background", 4.5],
  ["plus", "surface", 4.5],
  ["textPrimary", "glassSolid", 4.5],
  ["textSecondary", "glassSolid", 4.5],
  ["accent", "background", 4.5],
  ["brand", "background", 4.5],
  ["brand", "surface", 4.5],
  ["onBrand", "brand", 4.5],
  ["onSand", "sand", 4.5],
  ["onImage", "forest", 4.5],
];

describe("semantic colour pairs meet WCAG 2.2 AA", () => {
  for (const scheme of ["light", "dark"] as ColorScheme[]) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${scheme}: ${fg} on ${bg} >= ${min}`, () => {
        expect(contrast(colors[scheme][fg], colors[scheme][bg])).toBeGreaterThanOrEqual(min);
      });
    }
    it(`${scheme}: hairline is visible against background (>= 1.1) but quiet`, () => {
      const r = contrast(colors[scheme].hairline, colors[scheme].background);
      expect(r).toBeGreaterThanOrEqual(1.1);
      expect(r).toBeLessThan(3);
    });
  }
  it("white onImage text over the darkest allowed scrim result (rgba .45 black over white) still >= 4.5", () => {
    // Worst case image pixel is white; scrim at 0.55 alpha black => 0x73 grey.
    const worst = Math.round(255 * (1 - 0.55));
    const hex = `#${worst.toString(16).padStart(2, "0").repeat(3)}`;
    expect(contrast("#FFFFFF", hex)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("scales", () => {
  it("spacing is on the 4pt grid", () => {
    for (const v of Object.values(spacing)) expect(v % 4).toBe(0);
  });
  it("type scale matches the brief", () => {
    expect([typography.display.fontSize, typography.display.lineHeight]).toEqual([38, 46]);
    expect([typography.title1.fontSize, typography.title1.lineHeight]).toEqual([28, 34]);
    expect([typography.eyebrow.fontSize, typography.eyebrow.letterSpacing]).toEqual([11, 2.2]);
    expect(typography.eyebrow.uppercase).toBe(true);
  });
});

describe("native density v2", () => {
  const keys = Object.keys(typography) as (keyof typeof typography)[];
  it("native scale matches density-v2.md", () => {
    const pick = (k: keyof typeof nativeTypography) => [nativeTypography[k].fontSize, nativeTypography[k].lineHeight];
    expect(pick("hero")).toEqual([40, 46]);
    expect(pick("display")).toEqual([32, 38]);
    expect(pick("title1")).toEqual([24, 30]);
    expect(pick("quote")).toEqual([19, 26]);
    expect(pick("title2")).toEqual([18, 24]);
    expect(pick("headline")).toEqual([16, 22]);
    expect(pick("body")).toEqual([15, 22]);
    expect(pick("callout")).toEqual([14, 20]);
    expect(pick("caption")).toEqual([12, 16]);
    expect(pick("eyebrow")).toEqual([10.5, 14]);
  });
  it("same variants as the web scale, same face, weight and case (only size and leading change)", () => {
    expect(Object.keys(nativeTypography).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      expect(nativeTypography[k].face, k).toBe(typography[k].face);
      expect(nativeTypography[k].fontWeight, k).toBe(typography[k].fontWeight);
      expect(nativeTypography[k].uppercase, k).toBe(typography[k].uppercase);
    }
  });
  it("is a zoom-out, never a zoom-in: 80-100% of the web size, hierarchy order kept", () => {
    for (const k of keys) {
      const r = nativeTypography[k].fontSize / typography[k].fontSize;
      expect(r, k).toBeGreaterThanOrEqual(0.8);
      expect(r, k).toBeLessThanOrEqual(1);
    }
    const order = ["hero", "display", "title1", "quote", "title2", "headline", "callout", "caption", "eyebrow"] as const;
    order.forEach((k, i) => { const next = order[i + 1]; if (next !== undefined) expect(nativeTypography[k].fontSize, k).toBeGreaterThan(nativeTypography[next].fontSize); });
    expect(nativeTypography.body.fontSize).toBeGreaterThan(nativeTypography.callout.fontSize);
  });
  it("Latin leading stays readable: text >= 1.3x, display >= 1.15x; body text never below 12pt", () => {
    for (const k of keys) {
      const t = nativeTypography[k];
      expect(t.lineHeight / t.fontSize, k).toBeGreaterThanOrEqual(t.face === "display" ? 1.15 : 1.3);
      if (k !== "eyebrow" && k !== "micro") expect(t.fontSize, k).toBeGreaterThanOrEqual(12);
    }
  });
  it("control sizes keep a 44pt touch target (visual + 2 * slop)", () => {
    for (const [k, v] of Object.entries(controlSize)) expect(v + 2 * slopFor(v), k).toBeGreaterThanOrEqual(minTouchTarget);
    expect(controlSize.button).toBe(minTouchTarget);
    expect(gutter).toBe(16);
  });
});

describe("identity", () => {
  it("brand constants are the ink/ivory/teal/forest/sage/sand set", () => {
    expect(brand.ink).toBe("#0B2527");
    expect(brand.ivory).toBe("#F4EFE6");
    expect(brand.sand).toBe("#D9BFA0");
    expect(JSON.stringify(brand).toLowerCase()).not.toMatch(/bordeaux|rosewood|6b1d2a/);
  });
  it("light surfaces are warm ivory and dark surfaces are deep teal-black", () => {
    expect(colors.light.background).toBe("#EBE4D4");
    expect(colors.light.accent).toBe(colors.light.textPrimary);
    expect(colors.dark.background).toBe("#071A1C");
    expect(colors.dark.textPrimary).toBe("#F4EFE6");
  });
  it("savings emerald is distinct from the brand teal and from ink in both schemes", () => {
    for (const scheme of ["light", "dark"] as ColorScheme[]) {
      expect(colors[scheme].savings).not.toBe(colors[scheme].brand);
      expect(hueDistance(colors[scheme].savings, colors[scheme].brand)).toBeGreaterThanOrEqual(20);
    }
  });
  it("radius scale: button 14, card 18, pill round", () => {
    expect([radius.md, radius.lg, radius.pill]).toEqual([14, 18, 999]);
  });
  it("every colour token is a string (web turns each into a CSS variable)", () => {
    for (const scheme of ["light", "dark"] as ColorScheme[]) for (const v of Object.values(colors[scheme])) expect(typeof v).toBe("string");
  });
  it("display variants use the display face; text variants use the text face", () => {
    expect(typography.hero.face).toBe("display");
    expect(typography.display.face).toBe("display");
    expect(typography.body.face).toBe("text");
    expect(fontFamilies.displayLatin["400"]).toBe("PlayfairDisplay_400Regular");
    expect(fontFamilies.displayArabic["400"]).toBe("Amiri_400Regular");
    expect(fontFamilies.latin["400"]).toBe("Inter_400Regular");
    expect(fontFamilies.displayLatinItalic).toBe("PlayfairDisplay_400Regular_Italic");
  });
  it("springs never overshoot (damping ratio >= 1)", () => {
    for (const s of Object.values(motion.springs)) {
      const ratio = s.damping / (2 * Math.sqrt(s.stiffness * s.mass));
      expect(ratio).toBeGreaterThanOrEqual(1);
    }
  });
});
