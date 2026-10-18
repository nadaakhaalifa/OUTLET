import { describe, expect, it } from "vitest";
import { controlSize, minTouchTarget, radius, spacing, gutter, slopFor, IPAD_ZOOM, CONTROL_ZOOM, type nativeTypography } from "@outlet/ui-tokens";
import {
  columnMaxWidth, columnsFor, controlZoomFor, zoomForWidth, zoomKey, zoomInfoFor, contentColumnWidth, effectiveWidth, formSheetMaxHeight, formSheetWidth, gridColumnsForWindow,
  layoutFor, paneLayoutFor, renderedTextScale, roundEven, roundHalf, sizeClassFor, slopForPhysical, tabBarWidthCap,
  tabBarZoomExtra, toastWidthCap, typeZoomFactor, zoomEven, zoomRound, zoomedControlSize, zoomedRadii, zoomedSpacing,
  zoomedTextMetrics,
} from "./size-class";
import { controlMinHeight, MAX_FONT_SCALE } from "./touch";
import { textMetrics } from "./type";

// Pre-change values, copied from the tokens BEFORE the iPad work (compact must stay pixel-identical).
const COMPACT_SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48, huge: 64 };
const COMPACT_RADIUS = { xs: 4, sm: 8, md: 14, tile: 16, lg: 18, xl: 24, xxl: 32, pill: 999 };
const COMPACT_CONTROLS = { button: 44, buttonCompact: 40, field: 46, fieldCompact: 44, chip: 34, chipCompact: 30, chipLarge: 40, sizeCell: 40, search: 44, iconDisc: 36, categoryDisc: 48, appBar: 48, listRow: 48 };
const COMPACT_TYPE: Record<string, readonly [number, number, number]> = {
  hero: [40, 46, -0.5], display: [32, 38, -0.3], title1: [24, 30, -0.2], quote: [19, 26, -0.1], title2: [18, 24, 0], headline: [16, 22, 0],
  lede: [16, 24, 0], body: [15, 22, 0], callout: [14, 20, 0], caption: [12, 16, 0], brandName: [13, 18, 0], eyebrow: [10.5, 14, 2],
  micro: [10.5, 14, 0], offer: [22, 29, -0.3], tile: [13, 17, 0.3], title: [24, 30, -0.2], heading: [18, 24, 0],
};

describe("compact is pixel-identical to the pre-change tokens", () => {
  it("tokens themselves were not changed", () => {
    expect({ ...spacing }).toEqual(COMPACT_SPACING);
    expect({ ...radius }).toEqual(COMPACT_RADIUS);
    expect({ ...controlSize }).toEqual(COMPACT_CONTROLS);
    expect(gutter).toBe(16);
  });
  it("zoomed spacing, radii and controls at z = 1 deep-equal the snapshot", () => {
    expect(zoomedSpacing(1)).toEqual(COMPACT_SPACING);
    expect(zoomedRadii(1)).toEqual(COMPACT_RADIUS);
    expect(zoomedControlSize(1)).toEqual(COMPACT_CONTROLS);
  });
  it("390 pt window: z, gutter, gaps and s() are unchanged", () => {
    const l = layoutFor(390, 1);
    expect(l.sizeClass).toBe("compact");
    expect(l.z).toBe(1);
    expect(l.gutter).toBe(16);
    expect(l.sectionGap).toBe(14);
    expect(l.gridGap).toBe(12);
    expect(l.effectiveWidth).toBe(390);
    for (const n of [0, 1, 2, 3, 6, 10.5, 14, 16, 44, 76, 480]) expect(l.s(n)).toBe(n);
  });
  it("every compact text metric equals the old table, Latin and Arabic", () => {
    for (const [variant, [size, lh, ls]] of Object.entries(COMPACT_TYPE)) {
      {
        const m = textMetrics(variant as keyof typeof nativeTypography, { arabic: false, fontsLoaded: false, zoom: 1 });
        expect([m.fontSize, m.lineHeight, m.letterSpacing]).toEqual([size, lh, ls]);
        const ar = textMetrics(variant as keyof typeof nativeTypography, { arabic: true, fontsLoaded: false, zoom: 1 });
        expect([ar.fontSize, ar.lineHeight, ar.letterSpacing]).toEqual([size, Math.round((lh * 1.1) / 2) * 2, 0]);
        // omitting zoom (every pre-change caller) is the same thing
        expect(textMetrics(variant as keyof typeof nativeTypography, { arabic: false, fontsLoaded: false })).toEqual(m);
      }
    }
  });
  it("no compact window caps the content column, shows a form sheet, caps the tab bar or toast", () => {
    for (const w of [320, 375, 390, 430, 599]) {
      for (const kind of ["form", "reading", "grid", "full"] as const) expect(columnMaxWidth(kind, "compact", 16, 1)).toBeNull();
      expect(formSheetWidth(w)).toBeNull();
      expect(contentColumnWidth("reading", w)).toBe(w - 32);
      expect(layoutFor(w).paneLayout).toBe("single");
    }
    expect(tabBarWidthCap("compact", 1)).toBeNull();
    expect(toastWidthCap("compact", 1)).toBeNull();
    expect(tabBarZoomExtra(1)).toBe(0);
  });
  it("controlMinHeight keeps its old result with the default padding", () => {
    expect(controlMinHeight(10, 1)).toBe(44);
    expect(controlMinHeight(24, 2)).toBe(24 * 2 + 24);
  });
});

describe("zoom in force z(window): continuous ramp, never narrower than an iPhone", () => {
  it("599 compact, 600 regular, effective 759 regular (window 1310), effective 760 expanded (window 1311)", () => {
    expect(sizeClassFor(599)).toBe("compact");
    expect(sizeClassFor(599.9)).toBe("compact");
    expect(sizeClassFor(600)).toBe("regular");
    expect(sizeClassFor(1000)).toBe("regular");
    expect(sizeClassFor(1310)).toBe("regular");
    expect(sizeClassFor(1311)).toBe("expanded");
    expect(sizeClassFor(1376)).toBe("expanded");
    expect(1310 / IPAD_ZOOM).toBeLessThan(760);
    expect(1311 / IPAD_ZOOM).toBeGreaterThanOrEqual(760);
  });
  it("IPAD_ZOOM is the one (maximum) zoom constant (1.725); CONTROL_ZOOM is derived (~1.45)", () => {
    expect(IPAD_ZOOM).toBe(1.725);
    expect(CONTROL_ZOOM).toBeCloseTo(1.4495, 10);
    expect(controlZoomFor(IPAD_ZOOM)).toBe(CONTROL_ZOOM);
    expect(controlZoomFor(1)).toBe(1);
  });
  it("z is 1 below 600 and at 600 (no jump across the class boundary), then 1 + (w - 600) / 375 up to IPAD_ZOOM at ~872", () => {
    expect(zoomForWidth(599)).toBe(1);
    expect(zoomForWidth(600)).toBe(1);
    expect(zoomForWidth(750)).toBeCloseTo(1.4, 2);
    expect(zoomForWidth(871)).toBeLessThan(IPAD_ZOOM);
    expect(zoomForWidth(872)).toBe(IPAD_ZOOM);
    expect(zoomForWidth(1376)).toBe(IPAD_ZOOM);
    expect(zoomForWidth(5000)).toBe(IPAD_ZOOM);
  });
  it("property: z is monotonic non-decreasing in the width and stays in [1, IPAD_ZOOM]", () => {
    let prev = 0;
    for (let w = 0; w <= 2200; w += 0.5) {
      const z = zoomForWidth(w);
      expect(z).toBeGreaterThanOrEqual(1);
      expect(z).toBeLessThanOrEqual(IPAD_ZOOM);
      expect(z).toBeGreaterThanOrEqual(prev);
      prev = z;
    }
  });
  it("property: continuous across the class boundary and with steps no larger than 0.01 per point", () => {
    expect(Math.abs(zoomForWidth(600) - zoomForWidth(599.999))).toBe(0);
    let prev = zoomForWidth(0);
    for (let w = 1; w <= 2200; w += 1) {
      const z = zoomForWidth(w);
      expect(z - prev).toBeLessThanOrEqual(0.01 + 1e-9);
      prev = z;
    }
  });
  it("property: a zoomed window is never laid out narrower than an iPhone (effective >= 375 for every width >= 600) and w / z is finite", () => {
    for (let w = 600; w <= 2200; w += 1) {
      expect(effectiveWidth(w)).toBeGreaterThanOrEqual(375 - 1e-9);
      expect(layoutFor(w).effectiveWidth).toBeGreaterThanOrEqual(375 - 1e-9);
    }
    expect(effectiveWidth(600)).toBe(600);
  });
  it("effective width = window / z", () => {
    expect(effectiveWidth(390)).toBe(390);
    expect(effectiveWidth(700)).toBeCloseTo(700 / 1.27, 5);
    expect(effectiveWidth(1032)).toBeCloseTo(598.261, 2);
    expect(effectiveWidth(1376)).toBeCloseTo(797.681, 2);
  });
  it("garbage widths are compact with zero width", () => {
    for (const w of [NaN, -5, 0, Infinity * 0]) {
      expect(sizeClassFor(w)).toBe("compact");
      expect(effectiveWidth(w)).toBe(0);
      expect(zoomForWidth(w)).toBe(1);
    }
  });
  it("class depends on the window, never on orientation: the same width is the same layout", () => {
    expect(layoutFor(1032, 1)).toMatchObject({ sizeClass: "regular", gutter: 28, z: IPAD_ZOOM });
    expect(layoutFor(1376, 1)).toMatchObject({ sizeClass: "expanded", gutter: 35, z: IPAD_ZOOM });
    expect(layoutFor(600, 1)).toMatchObject({ sizeClass: "regular", gutter: 16, z: 1 });
  });
  it("memo key: a resize inside one class, zoom step and font scale keeps the key (the theme is not rebuilt)", () => {
    expect(zoomKey(390, 1)).toBe(zoomKey(430, 1));
    expect(zoomKey(900, 1)).toBe(zoomKey(1300, 1)); // plateau, still regular
    expect(zoomKey(1311, 1)).toBe(zoomKey(2000, 1));
    expect(zoomKey(1300, 1)).not.toBe(zoomKey(1311, 1));
    expect(zoomKey(600, 1)).not.toBe(zoomKey(599, 1));
    expect(zoomKey(700, 1)).not.toBe(zoomKey(700, 1.3));
    expect(zoomInfoFor(900, 1).s(20)).toBe(zoomInfoFor(1300, 1).s(20));
  });
});

describe("zoom tables re-derive from IPAD_ZOOM", () => {
  it("spacing 4,8,12,16,24,32,48,64 -> 7,14,21,28,41,55,83,110", () => {
    expect(Object.values(zoomedSpacing(IPAD_ZOOM))).toEqual([7, 14, 21, 28, 41, 55, 83, 110]);
  });
  it("radii 4,8,14,16,18,24,32 -> 7,14,24,28,31,41,55 and pill is unchanged", () => {
    const r = zoomedRadii(IPAD_ZOOM);
    expect([r.xs, r.sm, r.md, r.tile, r.lg, r.xl, r.xxl]).toEqual([7, 14, 24, 28, 31, 41, 55]);
    expect(r.pill).toBe(999);
  });
  it("controls (x1.45, rounded to even) match the table", () => {
    const c = zoomedControlSize(IPAD_ZOOM);
    expect([c.button, c.buttonCompact]).toEqual([64, 58]);
    expect([c.field, c.fieldCompact]).toEqual([66, 64]);
    expect([c.chip, c.chipCompact, c.chipLarge]).toEqual([50, 44, 58]);
    expect([c.sizeCell, c.search, c.iconDisc]).toEqual([58, 64, 52]);
    expect([c.categoryDisc, c.appBar, c.listRow]).toEqual([70, 70, 70]);
  });
  it("icon glyphs 20, 24 -> 29, 35 (control zoom); sc() and s() on layout", () => {
    const l = layoutFor(1032);
    expect([l.sc(20), l.sc(24)]).toEqual([29, 35]);
    expect([l.s(20), l.s(24)]).toEqual([35, 41]);
    expect(l.controlZ).toBeCloseTo(1.4495, 10);
  });
  it("changing the zoom re-derives every table (tuned zooms 1.25, 1.5, 2)", () => {
    for (const z of [1.25, 1.5, 2]) {
      const cz = 1 + (z - 1) * 0.62;
      expect(Object.values(zoomedSpacing(z))).toEqual(Object.values(spacing).map((v) => Math.round(v * z)));
      expect(Object.values(zoomedControlSize(z))).toEqual(Object.values(controlSize).map((v) => Math.round((v * cz) / 2) * 2));
      expect(zoomedRadii(z).pill).toBe(999);
    }
  });
  it("rounding helpers", () => {
    expect(roundEven(55)).toBe(56);
    expect(roundEven(57.5)).toBe(58);
    expect(roundHalf(26.25)).toBe(26);
    expect(roundHalf(18.375)).toBe(18.5);
    expect(roundHalf(24.5)).toBe(24.5);
    expect(roundHalf(13.1)).toBe(13);
    expect(zoomEven(44, 1)).toBe(44);
    expect(zoomRound(0, IPAD_ZOOM)).toBe(0);
  });
  it("layout metrics: regular 28/24/21, expanded 35/28/21 (physical)", () => {
    const r = layoutFor(1032);
    expect([r.gutter, r.sectionGap, r.gridGap]).toEqual([28, 24, 21]);
    const e = layoutFor(1376);
    expect([e.gutter, e.sectionGap, e.gridGap]).toEqual([35, 28, 21]);
  });
  it("every zoomed control is >= its compact value and >= 44 including slop", () => {
    const z = zoomedControlSize(IPAD_ZOOM);
    for (const k of Object.keys(controlSize) as (keyof typeof controlSize)[]) {
      expect(z[k]).toBeGreaterThanOrEqual(controlSize[k]);
      expect(z[k] + 2 * slopForPhysical(z[k])).toBeGreaterThanOrEqual(minTouchTarget);
    }
    expect(slopForPhysical(58)).toBe(0);
    expect(slopForPhysical(30)).toBe(slopFor(30));
  });
  it("touch targets stay >= 44 at all scales", () => {
    for (const w of [320, 599, 600, 744, 1032, 1376]) {
      const l = layoutFor(w);
      const c = zoomedControlSize(l.z);
      for (const k of Object.keys(c) as (keyof typeof c)[]) {
        expect(c[k] + 2 * slopForPhysical(c[k])).toBeGreaterThanOrEqual(minTouchTarget);
      }
      expect(l.sc(minTouchTarget)).toBeGreaterThanOrEqual(minTouchTarget);
    }
    for (const fs of [0.8, 1, 1.5, 2, 3]) expect(controlMinHeight(10, fs, 21)).toBeGreaterThanOrEqual(minTouchTarget);
  });
});

describe("labels fit in controls at fs 1 and fs 2, EN and AR (nothing clips)", () => {
  // Kit pairing: Button/Chip/Select = callout or caption, TextField = body, in the zoomed control heights.
  const cases: [string, keyof typeof nativeTypography, keyof typeof controlSize][] = [
    ["button", "callout", "button"], ["buttonCompact", "callout", "buttonCompact"], ["field", "body", "field"], ["fieldCompact", "callout", "fieldCompact"],
    ["chip", "caption", "chip"], ["chipLarge", "callout", "chipLarge"], ["listRow", "body", "listRow"],
  ];
  for (const [name, variant, control] of cases) {
    for (const fs of [1, 2]) {
      for (const arabic of [false, true]) {
        it(`${name} ${variant} fs ${fs} ${arabic ? "AR" : "EN"}: one line fits the zoomed control, and controlMinHeight never shrinks it`, () => {
          const m = textMetrics(variant, { arabic, fontsLoaded: false, zoom: IPAD_ZOOM });
          const line = m.lineHeight * Math.min(fs, MAX_FONT_SCALE);
          const h = zoomedControlSize(IPAD_ZOOM)[control];
          if (fs === 1) expect(line).toBeLessThanOrEqual(h);
          // at fs 2 the control grows with the text (minHeight, never a fixed height): it is never clipped
          expect(Math.max(h, controlMinHeight(m.lineHeight, fs, 0))).toBeGreaterThanOrEqual(line);
        });
      }
    }
  }
});

describe("type zoom: no Dynamic Type fade, cap = 2 x the zoom in force", () => {
  // Deterministic sweep (fast-check is not a dependency of this package): 0.8 .. 3.0 in steps of 0.001.
  const sweep = (from: number, to: number, f: (fs: number) => void): void => {
    for (let i = Math.round(from * 1000); i <= Math.round(to * 1000); i += 1) f(i / 1000);
  };
  it("k is the zoom in force at every font scale; compact is always 1", () => {
    expect(typeZoomFactor(IPAD_ZOOM)).toBe(1.725);
    expect(typeZoomFactor(1.4)).toBe(1.4);
    expect(typeZoomFactor(1)).toBe(1);
    expect(typeZoomFactor(0.5)).toBe(1);
  });
  it("T(fs) = z * min(fs, 2): T(1) = z, T(2) = 2z = 3.45 at full zoom, flat above; never above 2z (WCAG 1.4.4: Dynamic Type keeps its 2x)", () => {
    expect(renderedTextScale(1, IPAD_ZOOM)).toBe(1.725);
    expect(renderedTextScale(2, IPAD_ZOOM)).toBeCloseTo(3.45, 10);
    expect(renderedTextScale(3, IPAD_ZOOM)).toBeCloseTo(3.45, 10);
    for (const z of [1, 1.2, 1.5, IPAD_ZOOM]) {
      sweep(0.8, 3, (fs) => {
        const t = renderedTextScale(fs, z);
        expect(t).toBeLessThanOrEqual(2 * z + 1e-9);
        expect(t).toBeGreaterThanOrEqual(Math.min(fs, 2) - 1e-9 + (fs < 1 ? -0.2 : 0));
      });
    }
  });
  it("relative to the iPad default rendering, Dynamic Type grows text by the same 2x as on the phone", () => {
    for (const z of [1, 1.3, IPAD_ZOOM]) expect(renderedTextScale(2, z) / renderedTextScale(1, z)).toBeCloseTo(2, 10);
  });
  it("T is monotonic non-decreasing in fs and never below the phone size at the same setting (fs >= 1)", () => {
    let prev = -Infinity;
    sweep(0.8, 3, (fs) => {
      const t = renderedTextScale(fs, IPAD_ZOOM);
      expect(t).toBeGreaterThanOrEqual(prev - 1e-12);
      if (fs >= 1) expect(t).toBeGreaterThanOrEqual(Math.min(fs, 2));
      prev = t;
    });
  });
  it("garbage font scales fall back to 1", () => {
    for (const fs of [NaN, 0, -1]) expect(renderedTextScale(fs, IPAD_ZOOM)).toBe(1.725);
  });
  it("real tables: rounded point size x min(fs, 2) is within 2z of the phone size and never below the phone size", () => {
    for (const [variant, [size]] of Object.entries(COMPACT_TYPE)) {
      for (const z of [1.3, IPAD_ZOOM]) {
        const m = textMetrics(variant as keyof typeof nativeTypography, { arabic: false, fontsLoaded: false, zoom: z });
        expect(m.fontSize * 2).toBeLessThanOrEqual(size * 2 * z + 1);
        expect(m.fontSize).toBeGreaterThanOrEqual(size);
      }
    }
  });
  it("default text size at full zoom: body 15 -> 26, callout 14 -> 24, caption 12 -> 20.5, headline 16 -> 27.5, title1 24 -> 41.5, display 32 -> 55, hero 40 -> 69, micro 10.5 -> 18", () => {
    const at = (v: keyof typeof nativeTypography) => textMetrics(v, { arabic: false, fontsLoaded: false, zoom: IPAD_ZOOM });
    expect([at("body").fontSize, at("callout").fontSize, at("caption").fontSize, at("headline").fontSize]).toEqual([26, 24, 20.5, 27.5]);
    expect([at("title1").fontSize, at("display").fontSize, at("hero").fontSize, at("micro").fontSize]).toEqual([41.5, 55, 69, 18]);
    expect(at("micro").fontSize).toBeGreaterThanOrEqual(12);
    expect(at("body").lineHeight % 2).toBe(0);
  });
  it("tracking scales with the zoom (eyebrow) and Arabic tracking stays 0; Arabic +10% is applied after the zoom", () => {
    const en = textMetrics("eyebrow", { arabic: false, fontsLoaded: false, zoom: IPAD_ZOOM });
    expect(en.letterSpacing).toBeCloseTo(3.45, 10);
    const ar = textMetrics("body", { arabic: true, fontsLoaded: false, zoom: IPAD_ZOOM });
    expect(ar.letterSpacing).toBe(0);
    expect(ar.lineHeight).toBe(Math.round((roundEven(22 * IPAD_ZOOM) * 1.1) / 2) * 2);
  });
  it("zoomedTextMetrics returns the same object at z = 1 (compact)", () => {
    const base = { fontSize: 15, lineHeight: 22, letterSpacing: 0 };
    expect(zoomedTextMetrics(base, 1)).toBe(base);
  });
});

describe("two-pane only in expanded (effective window >= 760: 13-inch landscape only)", () => {
  it("single below 760, two at and above", () => {
    expect(paneLayoutFor(759.99)).toBe("single");
    expect(paneLayoutFor(760)).toBe("two");
    expect(paneLayoutFor(0)).toBe("single");
  });
  it("device windows: only 13-inch landscape (798 eff) is two-pane; 11-inch landscape (692 eff), every portrait, mini and Split View stay single", () => {
    expect(layoutFor(1376).paneLayout).toBe("two");
    expect(layoutFor(1366).paneLayout).toBe("two");
    expect(layoutFor(1194).paneLayout).toBe("single");
    expect(layoutFor(1210).paneLayout).toBe("single");
    expect(layoutFor(1133).paneLayout).toBe("single");
    expect(layoutFor(1032).paneLayout).toBe("single");
    expect(layoutFor(834).paneLayout).toBe("single");
    expect(layoutFor(744).paneLayout).toBe("single");
    expect(layoutFor(700).paneLayout).toBe("single");
    expect(layoutFor(390).paneLayout).toBe("single");
  });
  it("crossover at window 1311 = 760 * 1.725 and equals the expanded class; monotonic (no gutter-jump gap)", () => {
    expect(layoutFor(1310).paneLayout).toBe("single");
    expect(layoutFor(1311).paneLayout).toBe("two");
    let seenTwo = false;
    for (let w = 300; w <= 2000; w += 1) {
      const l = layoutFor(w);
      expect(l.paneLayout === "two").toBe(l.sizeClass === "expanded");
      if (seenTwo) expect(l.paneLayout).toBe("two");
      seenTwo = seenTwo || l.paneLayout === "two";
    }
  });
});

describe("content column widths (effective maxima form 440 / reading 560; grid and full uncapped)", () => {
  it("full zoom windows (>= 872 pt)", () => {
    expect(contentColumnWidth("form", 1032)).toBe(759);
    expect(contentColumnWidth("reading", 1032)).toBe(966); // 560 * 1.725 (window - gutters = 976)
    expect(contentColumnWidth("reading", 1376)).toBe(966);
    expect(contentColumnWidth("grid", 1376)).toBe(1376 - 70);
    expect(contentColumnWidth("full", 1376)).toBe(1376 - 70);
  });
  it("narrow regular windows: the zoom ramps, so the column scales with z and is limited by the window minus both gutters", () => {
    expect(contentColumnWidth("form", 600)).toBe(440); // z = 1: 440 pt
    expect(contentColumnWidth("form", 700)).toBe(Math.round(440 * zoomForWidth(700)));
    expect(contentColumnWidth("reading", 600)).toBe(560);
    expect(contentColumnWidth("grid", 744)).toBe(744 - 2 * layoutFor(744).gutter);
  });
  it("column box = max + both gutters; none for grid, full or compact", () => {
    expect(columnMaxWidth("form", "regular", 28, IPAD_ZOOM)).toBe(759 + 56);
    expect(columnMaxWidth("reading", "expanded", 35, IPAD_ZOOM)).toBe(966 + 70);
    expect(columnMaxWidth("grid", "expanded", 35, IPAD_ZOOM)).toBeNull();
    expect(columnMaxWidth("full", "expanded", 35, IPAD_ZOOM)).toBeNull();
    expect(columnMaxWidth("form", "compact", 16, 1)).toBeNull();
  });
  it("tab bar 828 pt (480 eff) and toast 621 pt (360 eff) caps at full zoom; the zoomed tab bar is 23 pt taller; none on compact", () => {
    expect(tabBarWidthCap("regular", IPAD_ZOOM)).toBe(828);
    expect(toastWidthCap("expanded", IPAD_ZOOM)).toBe(621);
    expect(tabBarZoomExtra(IPAD_ZOOM)).toBe(23);
    expect(tabBarZoomExtra(1)).toBe(0);
    expect(tabBarWidthCap("compact", 1)).toBeNull();
    expect(toastWidthCap("compact", 1)).toBeNull();
  });
});

describe("form sheet versus bottom sheet (switch at effective window 460)", () => {
  it("with the ramp every zoomed window is >= 505 eff, so every window >= 600 pt gets the form sheet; compact the bottom sheet", () => {
    for (const w of [320, 599]) expect(formSheetWidth(w)).toBeNull();
    for (let w = 600; w <= 2000; w += 7) expect(formSheetWidth(w)).not.toBeNull();
  });
  it("width = min(420 eff, effective - 2 gutters) * z: 420 at 600 pt (z = 1), 722 from 872 pt up (z = 1.725 gives 724.5, never past the window)", () => {
    expect(formSheetWidth(600)).toBe(420);
    expect(formSheetWidth(1032)).toBe(725);
    expect(formSheetWidth(1376)).toBe(725);
  });
  it("never wider than the window minus the gutters, and non-decreasing in the window width", () => {
    let prev = 0;
    for (let w = 600; w <= 1600; w += 1) {
      const l = layoutFor(w);
      const fw = formSheetWidth(w) as number;
      expect(fw).toBeLessThanOrEqual(w - 2 * l.gutter + 1);
      expect(fw).toBeGreaterThanOrEqual(prev - 2);
      prev = fw;
    }
  });
  it("max height is 85% of the window height", () => {
    expect(formSheetMaxHeight(1366)).toBe(1161);
    expect(formSheetMaxHeight(1000)).toBe(850);
    expect(formSheetMaxHeight(NaN)).toBe(0);
  });
});

describe("columnsFor on effective width (window / z)", () => {
  // Windows: 700 split, 744 mini portrait, 834 11" portrait, 1032 13" portrait, 1194 11" landscape, 1376 13" landscape.
  const WINDOWS = [700, 744, 834, 1032, 1194, 1376];
  const TABLE: Record<1 | 2 | 3 | 4, number[]> = {
    1: [2, 2, 1, 2, 2, 3],
    2: [3, 3, 3, 3, 4, 5],
    3: [5, 4, 4, 5, 6, 6],
    4: [6, 6, 6, 7, 8, 8],
  };
  for (const pref of [1, 2, 3, 4] as const) {
    it(`preference ${pref}`, () => {
      expect(WINDOWS.map((w) => gridColumnsForWindow(w, pref, 1))).toEqual(TABLE[pref]);
    });
  }
  it("13-inch landscape with the 220 eff filter panel open: the grid pane (761 - 220 - 12 = 529) gives 3 default columns", () => {
    expect(columnsFor(761 - 220 - 12, 2, 1, 12)).toBe(3);
  });
  it("columns are monotonic in width, >= 1 and <= the cap", () => {
    const caps = { 1: 3, 2: 5, 3: 6, 4: 8 } as const;
    for (const pref of [1, 2, 3, 4] as const) {
      let prev = 0;
      for (let w = 0; w <= 1400; w += 1) {
        const c = columnsFor(w, pref, 1, 12);
        expect(c).toBeGreaterThanOrEqual(1);
        expect(c).toBeLessThanOrEqual(caps[pref]);
        expect(c).toBeGreaterThanOrEqual(prev);
        prev = c;
      }
    }
  });
  it("large text grows minCard: x1.25 at fs >= 1.3, x1.5 at fs >= 1.5 (never more columns than at fs 1)", () => {
    for (const pref of [1, 2, 3, 4] as const) {
      for (const w of [300, 400, 528, 563, 778, 858, 1024]) {
        const a = columnsFor(w, pref, 1, 12);
        const b = columnsFor(w, pref, 1.3, 12);
        const c = columnsFor(w, pref, 1.5, 12);
        expect(b).toBeLessThanOrEqual(a);
        expect(c).toBeLessThanOrEqual(b);
      }
    }
    expect(columnsFor(558, 2, 1, 12)).toBe(3);
    expect(columnsFor(558, 2, 1.5, 12)).toBe(2);
  });
  it("is stable for garbage widths", () => {
    expect(columnsFor(NaN, 2, 1)).toBe(1);
    expect(columnsFor(-10, 4, NaN)).toBe(1);
  });
});
