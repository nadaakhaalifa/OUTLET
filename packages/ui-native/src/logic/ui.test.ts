import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { colors, minTouchTarget } from "@outlet/ui-tokens";
import { buttonStyle, clampFontScale, contrastRatio, controlMinHeight, directionForLocale, fieldView, hitSlopFor, iconScaleX, InvalidColorError, resolveScreenStatus, scaleSize, toneColors, accessibleName, validateInteractive, MAX_FONT_SCALE } from "./index";

describe("contrast", () => {
  it("black on white is 21", () => expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5));
  it("rejects bad colours", () => expect(() => contrastRatio("red", "#FFFFFF")).toThrow(InvalidColorError));
  for (const scheme of ["light", "dark"] as const) {
    const c = colors[scheme];
    it(`${scheme}: token pairs meet WCAG AA 4.5`, () => {
      expect(contrastRatio(c.textPrimary, c.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.textPrimary, c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.textSecondary, c.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.onAccent, c.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.onDanger, c.danger)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.fieldBorder, c.background)).toBeGreaterThanOrEqual(3); // input outline (1.4.11)
      expect(contrastRatio(c.fieldBorder, c.surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(c.accent, c.background)).toBeGreaterThanOrEqual(3); // secondary button border/label (large/UI)
    });
    it(`${scheme}: banner tones are legible`, () => {
      for (const tone of ["info", "warning", "error"] as const) {
        const t = toneColors(tone, scheme);
        expect(contrastRatio(t.foreground, t.background)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("touch and type", () => {
  it("clamps font scale", () => {
    expect(clampFontScale(NaN)).toBe(1);
    expect(clampFontScale(-1)).toBe(1);
    expect(clampFontScale(5)).toBe(MAX_FONT_SCALE);
  });
  it("never shrinks below base", () => expect(scaleSize(16, 0.5)).toBe(16));
  it("controls are at least 44pt and grow with scale", () => {
    expect(controlMinHeight(10, 1)).toBeGreaterThanOrEqual(minTouchTarget);
    expect(controlMinHeight(24, 2)).toBeGreaterThan(controlMinHeight(24, 1));
  });
  it("hitSlop lifts small targets to 44", () => {
    const s = hitSlopFor(24, 24);
    expect(24 + s.start + s.end).toBeGreaterThanOrEqual(minTouchTarget);
    expect(hitSlopFor(60, 60)).toEqual({ top: 0, bottom: 0, start: 0, end: 0 });
  });
});

describe("button", () => {
  const c = colors.light;
  it("loading blocks interaction and sets busy", () => {
    const s = buttonStyle({ variant: "primary", loading: true, disabled: false, pressed: false }, c);
    expect(s.interactive).toBe(false);
    expect(s.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(s.opacity).toBe(1);
  });
  it("disabled is a neutral flat fill, never the variant colour", () => {
    const s = buttonStyle({ variant: "destructive", loading: false, disabled: true, pressed: true }, c);
    expect(s.opacity).toBe(0.7);
    expect(s.background).toBe(c.fill);
    expect(s.foreground).toBe(c.textSecondary);
  });
  it("variants map to tokens", () => {
    expect(buttonStyle({ variant: "primary", loading: false, disabled: false, pressed: false }, c).background).toBe(c.accent);
    expect(buttonStyle({ variant: "secondary", loading: false, disabled: false, pressed: false }, c).foreground).toBe(c.accent);
  });
});

describe("field", () => {
  const c = colors.dark;
  it("error beats helper", () => {
    const v = fieldView({ error: "Required", helper: "Hint", focused: true, disabled: false }, c);
    expect(v.message).toBe("Required");
    expect(v.borderColor).toBe(c.danger);
    expect(v.isError).toBe(true);
  });
  it("helper, focus, disabled", () => {
    expect(fieldView({ helper: "Hint", focused: false, disabled: false }, c).message).toBe("Hint");
    expect(fieldView({ focused: true, disabled: false }, c).borderColor).toBe(c.brand);
    expect(fieldView({ error: "", focused: false, disabled: true }, c)).toMatchObject({ isError: false, opacity: 0.5, message: null });
  });
});

describe("screen status", () => {
  const base = { isLoading: false, isOnline: true, hasError: false, itemCount: 0 };
  it("table", () => {
    expect(resolveScreenStatus({ ...base, isLoading: true })).toBe("loading");
    expect(resolveScreenStatus({ ...base, isOnline: false, hasError: true })).toBe("offline");
    expect(resolveScreenStatus({ ...base, hasError: true })).toBe("error");
    expect(resolveScreenStatus(base)).toBe("empty");
    expect(resolveScreenStatus({ ...base, itemCount: 3, hasError: true, isOnline: false })).toBe("ready");
    expect(resolveScreenStatus({ ...base, hasCachedData: true, isOnline: false })).toBe("ready");
  });
});

describe("direction and a11y", () => {
  it("locales", () => {
    expect(directionForLocale("ar-EG")).toBe("rtl");
    expect(directionForLocale("en_US")).toBe("ltr");
    expect(iconScaleX("rtl", true)).toBe(-1);
    expect(iconScaleX("rtl", false)).toBe(1);
    expect(iconScaleX("ltr", true)).toBe(1);
  });
  it("names and validation", () => {
    expect(accessibleName("  ", "Pay")).toBe("Pay");
    expect(accessibleName(undefined, " ")).toBeNull();
    expect(validateInteractive({ role: "button", name: null, width: 30, height: 44, minTarget: 44 }).map((i) => i.rule)).toEqual(["name", "target-size"]);
    expect(validateInteractive({ role: "button", name: "Pay", width: 44, height: 44, minTarget: 44 })).toEqual([]);
  });
});

import { themeFor } from "./palette";
import { arrowName, badgeView, chevronName, glassMode, glassStyle, initials, isValidClaim, motionDuration, parseThemePreference, physicalEdge, previewDirection, priceView, progressRatio, ratingView, resolveScheme, scrimStops, sizeCellView, stepQuantity, tabBarInset, tabBadgeText, tabBarBottomOffset, textMetrics, staggerDelay, entranceSpec, collapseProgress, heroParallax, pressFeedback } from "./index";

describe("rtl helpers", () => {
  it("chevrons mirror", () => {
    expect(chevronName(false)).toBe("chevron-forward");
    expect(chevronName(true)).toBe("chevron-back");
    expect(chevronName(true, "back")).toBe("chevron-forward");
    expect(arrowName(true)).toBe("arrow-back");
    expect(arrowName(false, "back")).toBe("arrow-back");
  });
  it("preview direction only when it differs from native", () => {
    expect(previewDirection(true, true)).toBeNull();
    expect(previewDirection(true, false)).toBe("rtl");
    expect(previewDirection(false, true)).toBe("ltr");
  });
  it("physical edges", () => {
    expect(physicalEdge("start", false)).toBe("left");
    expect(physicalEdge("start", true)).toBe("right");
    expect(physicalEdge("end", true)).toBe("left");
  });
});

describe("type metrics", () => {
  it("arabic: +10% line height, no tracking, no uppercase", () => {
    const en = textMetrics("eyebrow", { arabic: false, fontsLoaded: true });
    const ar = textMetrics("eyebrow", { arabic: true, fontsLoaded: true });
    expect(en.textTransform).toBe("uppercase");
    // Density v2 (native scale): eyebrow tracking 2.2 -> 2, body 16/24 -> 15/22 (Arabic 26 -> 24).
    expect(en.letterSpacing).toBe(2);
    expect(ar.textTransform).toBe("none");
    expect(ar.letterSpacing).toBe(0);
    expect(textMetrics("body", { arabic: true, fontsLoaded: true }).lineHeight).toBe(24);
    expect(textMetrics("body", { arabic: false, fontsLoaded: true }).lineHeight).toBe(22);
  });
  it("density v2: Arabic always gets more leading than Latin, and enough of it", () => {
    for (const v of ["hero", "display", "title1", "quote", "title2", "headline", "lede", "body", "callout", "caption", "eyebrow"] as const) {
      const en = textMetrics(v, { arabic: false, fontsLoaded: true });
      const ar = textMetrics(v, { arabic: true, fontsLoaded: true });
      expect(ar.fontSize, v).toBe(en.fontSize);
      expect(ar.lineHeight, v).toBeGreaterThan(en.lineHeight);
      expect(ar.lineHeight / ar.fontSize, v).toBeGreaterThanOrEqual(1.25);
    }
    expect(textMetrics("callout", { arabic: false, fontsLoaded: true, numeric: true }).tabularNums).toBe(true);
  });
  it("falls back to system font when fonts are not loaded", () => {
    expect(textMetrics("body", { arabic: false, fontsLoaded: false }).fontFamily).toBeUndefined();
    expect(textMetrics("body", { arabic: true, fontsLoaded: true }).fontFamily).toBe("IBMPlexSansArabic_400Regular");
    expect(textMetrics("display", { arabic: false, fontsLoaded: true }).fontFamily).toBe("PlayfairDisplay_400Regular");
    expect(textMetrics("display", { arabic: true, fontsLoaded: true }).fontFamily).toBe("Amiri_400Regular");
    expect(textMetrics("lede", { arabic: false, fontsLoaded: true }).fontFamily).toBe("Inter_400Regular");
  });
});

describe("price claims are never shown unless verified and consistent", () => {
  const claim = { referenceMinor: 100000n, percent: 25, verified: true };
  it("valid claim", () => {
    expect(isValidClaim(75000n, claim)).toBe(true);
    expect(priceView(75000n, claim, false)).toEqual({ kind: "claim", percent: 25 });
  });
  it("rejects unverified, wrong percent, below 5, ref <= price, undefined", () => {
    expect(isValidClaim(75000n, { ...claim, verified: false })).toBe(false);
    expect(isValidClaim(75000n, { ...claim, percent: 30 })).toBe(false);
    expect(isValidClaim(96000n, { ...claim, percent: 4 })).toBe(false);
    expect(isValidClaim(100000n, claim)).toBe(false);
    expect(isValidClaim(120000n, claim)).toBe(false);
    expect(isValidClaim(75000n, undefined)).toBe(false);
    expect(isValidClaim(75000n, { ...claim, percent: 25.5 })).toBe(false);
  });
  it("percent is floored", () => {
    expect(isValidClaim(66667n, { referenceMinor: 100000n, percent: 33, verified: true })).toBe(true);
  });
  it("launch and plain", () => {
    expect(priceView(5000n, undefined, true)).toEqual({ kind: "launch" });
    expect(priceView(5000n, { ...claim, verified: false }, false)).toEqual({ kind: "plain" });
  });
});

describe("glass", () => {
  it("falls back to solid when reduce transparency or unsupported", () => {
    expect(glassMode({ reduceTransparency: true, blurSupported: true })).toBe("solid");
    expect(glassMode({ reduceTransparency: false, blurSupported: false })).toBe("solid");
    expect(glassMode({ reduceTransparency: false, blurSupported: true })).toBe("blur");
  });
  it("style uses solid colour in fallback", () => {
    expect(glassStyle("solid", false, colors.light, 60).backgroundColor).toBe(colors.light.glassSolid);
    expect(glassStyle("blur", true, colors.dark, 60).blurTint).toBe("systemChromeMaterialDark");
  });
  it("scrim", () => {
    expect(scrimStops("bottom").colors).toHaveLength(2);
    expect(scrimStops("both").locations).toHaveLength(4);
  });
});

describe("misc view logic", () => {
  it("theme preference", () => {
    expect(resolveScheme("system", "dark")).toBe("dark");
    expect(resolveScheme("light", "dark")).toBe("light");
    expect(resolveScheme("system", null)).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("x")).toBe("system");
  });
  it("reduce motion zeroes durations", () => {
    expect(motionDuration(true, 300)).toBe(0);
    expect(motionDuration(false, 300)).toBe(300);
  });
  it("progress", () => {
    expect(progressRatio(1950, 2000)).toBeCloseTo(0.975);
    expect(progressRatio(3000, 2000)).toBe(1);
    expect(progressRatio(-5, 2000)).toBe(0);
    expect(progressRatio(5, 0)).toBe(1);
  });
  it("badges: verified is emerald, live has coral dot, plus gold", () => {
    expect(badgeView("verified").fg).toBe("savings");
    expect(badgeView("live").dot).toBe("danger");
    expect(badgeView("plus").fg).toBe("plus");
  });
  it("size cells", () => {
    expect(sizeCellView({ available: false, selected: false, yours: false })).toMatchObject({ strike: true, interactive: false });
    expect(sizeCellView({ available: true, selected: false, yours: true }).ring).toBe(true);
    expect(sizeCellView({ available: true, selected: true, yours: true })).toMatchObject({ filled: true, ring: false });
  });
  it("quantity", () => {
    expect(stepQuantity(1, -1, 1, 10)).toBeNull();
    expect(stepQuantity(10, 1, 1, 10)).toBeNull();
    expect(stepQuantity(3, 1, 1, 10)).toBe(4);
  });
  it("rating needs real data", () => {
    expect(ratingView(null, 10).show).toBe(false);
    expect(ratingView(4.6, 0).show).toBe(false);
    expect(ratingView(4.6, 12)).toEqual({ show: true, filled: 4, half: true });
    expect(ratingView(6, 3).show).toBe(false);
  });
  it("initials and tab inset", () => {
    expect(initials("  zara home ")).toBe("ZH");
    expect(initials("")).toBe("");
    expect(tabBarInset(34)).toBe(66);
    expect(tabBarInset(0)).toBe(52);
  });
});

describe("motion logic", () => {
  it("staggers by 60ms and caps at 8 items", () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(3)).toBe(180);
    expect(staggerDelay(50)).toBe(480);
    expect(staggerDelay(-2)).toBe(0);
    expect(staggerDelay(Number.NaN)).toBe(0);
  });
  it("entrance is skipped under Reduce Motion", () => {
    expect(entranceSpec(2, true)).toBeNull();
    expect(entranceSpec(2, false)).toEqual({ delay: 120, duration: 520, distance: 16 });
  });
  it("collapse progress clamps to 0..1", () => {
    expect(collapseProgress(-10)).toBe(0);
    expect(collapseProgress(36)).toBe(0.5);
    expect(collapseProgress(500)).toBe(1);
  });
  it("hero parallax drifts and zooms on pull-down", () => {
    expect(heroParallax(100, 400)).toEqual({ translateY: 40, scale: 1 });
    expect(heroParallax(-100, 400).scale).toBe(1.25);
  });
  it("press feedback drops the scale under Reduce Motion", () => {
    expect(pressFeedback(true).scale).toBe(1);
    expect(pressFeedback(false).scale).toBe(0.97);
  });
  it("brand button uses the teal brand role and blocks while loading", () => {
    const c = themeFor("light");
    const st = buttonStyle({ variant: "brand", loading: true, disabled: false, pressed: false }, c);
    expect(st.background).toBe(c.brand);
    expect(st.interactive).toBe(false);
  });
});

describe("plus surface tokens and glass fades", () => {
  it("plus surface text meets AA in both schemes", async () => {
    const { colors } = await import("@outlet/ui-tokens");
    for (const s of ["light", "dark"] as const) {
      expect(contrastRatio(colors[s].onPlusSurface, colors[s].plusSurface)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("warning tone is built from tokens", async () => {
    const { colors } = await import("@outlet/ui-tokens");
    expect(toneColors("warning", "dark").background).toBe(colors.dark.plusSurface);
  });
  it("fadeOut keeps the hue and zeroes alpha", async () => {
    const { fadeOut } = await import("./glass");
    expect(fadeOut("rgba(11,37,39,0.06)")).toBe("rgba(11,37,39,0)");
    expect(fadeOut("#FFFFFF")).toBe("rgba(255,255,255,0)");
  });
});

import { textWritingDirection as _twd } from "./rtl";
describe("textWritingDirection", () => {
  it("follows the script of the content, then the app direction", () => {
    expect(_twd("Edit product", true)).toBe("ltr");
    expect(_twd("تعديل المنتج", false)).toBe("rtl");
    expect(_twd("12 345", true)).toBe("rtl");
    expect(_twd("12 345", false)).toBe("ltr");
    expect(_twd("١٢ منتج", false)).toBe("rtl");
  });
});

describe("floating tab bar logic", () => {
  it("offsets the pill above the home indicator, with a floor", () => {
    expect(tabBarBottomOffset(34)).toBe(0);
    expect(tabBarBottomOffset(0)).toBe(0);
  });
  it("hides the badge at zero and caps at 99+", () => {
    expect(tabBadgeText(0)).toBeNull();
    expect(tabBadgeText(undefined)).toBeNull();
    expect(tabBadgeText(3)).toBe("3");
    expect(tabBadgeText(120)).toBe("99+");
  });
});

import { headerState, nextOpenSection, sectionSummary, showVerifiedGlyph, storeNameLines } from "./brand";
import { nativeTypography, typography } from "@outlet/ui-tokens";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("store and brand names (round-2 item 3)", () => {
  it("brandName role: semibold, not uppercase, caption + 1 step, both scales", () => {
    for (const s of [typography, nativeTypography]) {
      expect(s.brandName.fontWeight).toBe("600");
      expect(s.brandName.uppercase).toBe(false);
      expect(s.brandName.fontSize).toBe(s.caption.fontSize + 1);
    }
    expect(textMetrics("brandName", { arabic: true, fontsLoaded: false }).lineHeight).toBe(20);
    expect(textMetrics("brandName", { arabic: false, fontsLoaded: false }).lineHeight).toBe(18);
  });
  it("lines and verified glyph", () => {
    expect(storeNameLines("tile")).toBe(1);
    expect(storeNameLines("row")).toBe(2);
    expect(showVerifiedGlyph(true)).toBe(true);
    expect(showVerifiedGlyph(false)).toBe(false);
    expect(showVerifiedGlyph(undefined)).toBe(false);
    expect(showVerifiedGlyph(null)).toBe(false);
  });
  it("brandName text colour is textPrimary: AA on background and surface in both schemes", () => {
    for (const scheme of ["light", "dark"] as const) {
      for (const bg of ["background", "surface"] as const) {
        expect(contrastRatio(colors[scheme].textPrimary, colors[scheme][bg])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("the kit renders store names through StoreName, never secondary/caption", () => {
    const src = readFileSync(join(__dirname, "../components/commerce.tsx"), "utf8");
    expect(src).toMatch(/<StoreName name=\{props\.sellerName\}/);
    expect(src).not.toMatch(/sellerName[^\n]*secondary/);
    expect(readdirSync(join(__dirname, "../components")).includes("accordion.tsx")).toBe(true);
  });
  it("accordion keeps one section open", () => {
    expect(nextOpenSection(null, "a")).toBe("a");
    expect(nextOpenSection("a", "b")).toBe("b");
    expect(nextOpenSection("a", "a")).toBeNull();
    expect(sectionSummary("Brand", "2 selected")).toBe("Brand, 2 selected");
    expect(sectionSummary("Brand", null)).toBe("Brand");
  });
});

describe("accordion header accessibility", () => {
  it("announces expanded or collapsed and the component passes it", () => {
    expect(headerState(true)).toEqual({ expanded: true });
    expect(headerState(false)).toEqual({ expanded: false });
    expect(readFileSync(join(__dirname, "../components/accordion.tsx"), "utf8")).toMatch(/accessibilityState=\{headerState\(isOpen\)\}/);
  });
});

describe("window width is read in exactly one place (iPad size classes)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, "..");
  const files = [join(src, "theme.tsx"), ...readdirSync(join(src, "components")).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)).map((f) => join(src, "components", f))];
  it("only theme.tsx calls useWindowDimensions; no kit component uses Dimensions or Platform.isPad", () => {
    for (const f of files) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (!f.endsWith("theme.tsx")) expect(code, f).not.toMatch(/useWindowDimensions|\bDimensions\b/);
      expect(code, f).not.toMatch(/Platform\.isPad/);
    }
    expect(readFileSync(join(src, "theme.tsx"), "utf8")).toMatch(/useWindowDimensions/);
  });
});

describe("theme rebuild guard (iPad size classes)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const theme = readFileSync(join(here, "..", "theme.tsx"), "utf8");
  it("the provider theme and zoom info are keyed on the zoom key, never on the raw window width", () => {
    expect(theme).toMatch(/zoomParts\(zoomInfoFor\(winWidth, winFontScale\)\), \[zkey\]/);
    const valueMemo = theme.slice(theme.indexOf("const value = useMemo<ThemeValue>"), theme.indexOf("const layout = useMemo"));
    expect(valueMemo).not.toMatch(/winWidth|winHeight/);
  });
  it("useTheme does not subscribe to the window (only a provider-less fallback reads it, without a hook)", () => {
    const useThemeSrc = theme.slice(theme.indexOf("export function useTheme()"), theme.indexOf("export function useLayout()"));
    expect(useThemeSrc).not.toMatch(/useWindowDimensions/);
  });
});
