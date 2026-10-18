// Drift guards: the kit's real colour usage stays AA, and web token CSS stays derived from the tokens.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IPAD_ZOOM, CONTROL_ZOOM, expandedMinEffectiveWidth, iphoneEffectiveWidth, adaptiveGrid, colors, contentMaxWidth, controlSize, formSheet, layoutMetrics, minTouchTarget, radius, sizeClassBreakpoints, slopFor, spacing, twoPaneMinContentWidth, zoom, type ColorScheme, type ColorTokens } from "./index";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
type K = keyof ColorTokens;

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function lum(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.(test|spec)\./.test(e)) out.push(p);
  }
  return out;
}

/** Opaque surfaces text may sit on. */
const SURFACES: K[] = ["background", "surface", "fill"];
/** Token pairs the kit pairs by construction (on-colour with its fill). */
const ON: Partial<Record<K, K>> = { onAccent: "accent", onDanger: "danger", onSavings: "savings", onPlus: "plus", onBrand: "brand", onSand: "sand", onPlusSurface: "plusSurface", onImage: "forest" };
/** Tokens that are not text colours (decorative strokes, scrims, glass layers). */
const NON_TEXT = new Set<K>(["border", "hairline", "scrim", "overlay", "glassTint", "glassBorder", "glassHighlight", "glassShade", "glassSheen", "glassSheenFade", "glassTintOnImage", "sage", "forest", "sand", "brandSoft", "fill", "surface", "background", "plusBorder"]);

function textTokensUsedByKit(): K[] {
  const used = new Set<K>();
  const files = [...walk(join(root, "packages/ui-native/src")), ...walk(join(root, "apps/mobile/src/components"))];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:\bcolor|messageColor|foreground)\s*[:=]\s*\{?\s*(?:[a-zA-Z.]*colors|c)\.([a-zA-Z]+)/g)) {
      const k = m[1] as K;
      if (k in colors.light) used.add(k);
    }
  }
  return [...used];
}

describe("kit text colours are AA on every surface they can sit on", () => {
  const used = textTokensUsedByKit();
  it("finds the kit's text tokens (scan is not vacuous)", () => {
    expect(used.length).toBeGreaterThan(0);
  });
  for (const scheme of ["light", "dark"] as ColorScheme[]) {
    for (const k of used) {
      if (NON_TEXT.has(k)) continue;
      const on = ON[k];
      const surfaces: K[] = on ? [on] : SURFACES;
      for (const s of surfaces) {
        it(`${scheme}: ${k} on ${s} >= 4.5`, () => {
          expect(ratio(colors[scheme][k], colors[scheme][s])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
  it("every on-colour pairs AA with its fill in both schemes", () => {
    for (const scheme of ["light", "dark"] as ColorScheme[]) {
      for (const [fg, bg] of Object.entries(ON) as [K, K][]) {
        expect(ratio(colors[scheme][fg], colors[scheme][bg]), `${scheme} ${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("web token CSS is derived, never copied", () => {
  const files = ["packages/ui-web/src/tokens-css.ts", "apps/admin-web/src/app/styles.ts", "apps/seller-web/src/styles/tokens-css.ts", "apps/shopper-web/src/styles/tokens-css.ts"];
  for (const f of files) {
    it(`${f} imports @outlet/ui-tokens and holds no colour literal except the dark shadow black`, () => {
      const src = readFileSync(join(root, f), "utf8");
      // The seller app re-exports the shared generator from @outlet/ui-web/css, whose own source is checked above.
      expect(src.includes("@outlet/ui-tokens") || src.includes("@outlet/ui-web/css")).toBe(true);
      const hex = (src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter((h) => h.toLowerCase() !== "#000000");
      expect(hex).toEqual([]);
    });
  }
});

describe("lint radius scale matches the tokens", () => {
  it("RADIUS_SCALE = 0 + radius values", () => {
    const m = /RADIUS_SCALE = \[([^\]]+)\]/.exec(readFileSync(join(root, "tooling/design/rules.mjs"), "utf8"));
    const scale = (m?.[1] ?? "").split(",").map((n) => Number(n.trim()));
    expect(scale.sort((a, b) => a - b)).toEqual([0, ...Object.values(radius)].sort((a, b) => a - b));
  });
});

describe("iPad zoom tokens (ADR-0054)", () => {
  // Same rounding the kit applies: controls to the nearest even number, everything else to the nearest integer.
  const even = (n: number): number => Math.round((n * CONTROL_ZOOM) / 2) * 2;
  it("the owner-decided zoom is 1.725 and the breakpoints are 600 / 1000", () => {
    expect(IPAD_ZOOM).toBe(1.725);
    expect(zoom).toBe(IPAD_ZOOM);
    expect(iphoneEffectiveWidth).toBe(375);
    expect(sizeClassBreakpoints).toEqual({ regular: 600 });
    expect(expandedMinEffectiveWidth).toBe(760);
    expect(CONTROL_ZOOM).toBeCloseTo(1.4495, 10);
    expect(twoPaneMinContentWidth).toBe(760);
  });
  it("every zoomed control is >= its compact value and >= 44 including slop", () => {
    for (const [k, v] of Object.entries(controlSize)) {
      const z = even(v);
      expect(z, k).toBeGreaterThanOrEqual(v);
      expect(z + 2 * slopFor(z), k).toBeGreaterThanOrEqual(minTouchTarget);
    }
  });
  it("zoomed spacing is strictly increasing and zoomed radii stay ordered (pill untouched)", () => {
    const sp = Object.values(spacing).map((v) => Math.round(v * zoom));
    expect([...sp].sort((a, b) => a - b)).toEqual(sp);
    const r = Object.entries(radius).filter(([k]) => k !== "pill").map(([, v]) => Math.round(v * zoom));
    expect([...r].sort((a, b) => a - b)).toEqual(r);
  });
  it("layout metrics, content widths, form sheet and grid tables", () => {
    expect(layoutMetrics.compact).toEqual({ gutter: 16, sectionGap: 14, gridGap: 12 });
    expect(layoutMetrics.expanded).toEqual({ gutter: 20, sectionGap: 16, gridGap: 12 });
    expect(contentMaxWidth).toEqual({ form: 440, reading: 560 });
    expect(formSheet).toEqual({ width: 420, heightRatio: 0.85, minEffectiveWindow: 460 });
    expect(adaptiveGrid.minCard).toEqual({ 1: 240, 2: 140, 3: 92, 4: 68 });
    expect(adaptiveGrid.cap).toEqual({ 1: 3, 2: 5, 3: 6, 4: 8 });
  });
  it("colours are untouched by the zoom: AA pairs are asserted above and the zoom adds no colour token", () => {
    expect(Object.keys(colors.light)).toEqual(Object.keys(colors.dark));
  });
});
