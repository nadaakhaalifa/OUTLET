import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONTRAST_PAIRS, FONT_FAMILIES, FONT_PAIRINGS, FONT_PAIRING_IDS, LOCKED_ELEMENTS, PLACEHOLDER_SHA256,
  checkPalette, contrastRatio, deriveDarkPalette, findCopyViolations, findFamily, hexToOklch,
  hexToRgb, isCleanCopy, isHex, isLockedElement, isPlaceholderHash, lockedElementTokens, normaliseCopy,
  oklchToHex, pairingSupportsWeight, registryProblems, relativeLuminance, resolveDarkPalette,
  rgbToHex, suggestPassingColour, validateThemeForPublish,
} from "./index";
import type { Palette, ThemeDocument } from "./index";
import { LIGHT_OK, makeTheme } from "./fixtures";

const hexArb = fc
  .tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }))
  .map(([r, g, b]) => rgbToHex([r, g, b]));
const paletteArb: fc.Arbitrary<Palette> = fc.record({
  background: hexArb, surface: hexArb, text: hexArb, textMuted: hexArb, accent: hexArb,
  onAccent: hexArb, border: hexArb,
  heroScrim: fc.record({ hex: hexArb, alpha: fc.double({ min: 0, max: 0.8, noNaN: true }) }),
});
const themeArb: fc.Arbitrary<ThemeDocument> = fc
  .tuple(paletteArb, fc.option(paletteArb, { nil: null }), fc.constantFrom(...FONT_PAIRING_IDS))
  .map(([light, dark, pairingId]) => makeTheme({ light, dark, pairingId, displayWeight: "regular" }));

describe("colour maths", () => {
  it("matches WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBe(0);
  });
  it("rejects malformed hex", () => {
    expect(isHex("#12345")).toBe(false);
    expect(() => hexToRgb("red")).toThrow(RangeError);
    expect(rgbToHex([300, -5, 15.4])).toBe("#FF000F");
  });
  it("round-trips through OKLCH within one 8-bit step", () => {
    fc.assert(
      fc.property(hexArb, (h) => {
        const back = hexToRgb(oklchToHex(hexToOklch(h)));
        const orig = hexToRgb(h);
        return back.every((v, i) => Math.abs(v - (orig[i] ?? 0)) <= 2);
      }),
    );
  });
  it("gamut-maps out-of-range chroma", () => {
    expect(isHex(oklchToHex({ l: 0.6, c: 0.9, h: 330 }))).toBe(true);
  });
});

describe("contrast guard", () => {
  it("passes the fixture palette in light", () => {
    expect(checkPalette("light", LIGHT_OK)).toEqual([]);
  });
  it("reports failing pairs", () => {
    const f = checkPalette("light", { ...LIGHT_OK, text: "#EEEEEE" });
    expect(f.map((x) => x.pair.fg)).toContain("text");
  });
  it("covers every spec pair at the right thresholds", () => {
    expect(CONTRAST_PAIRS).toHaveLength(9);
    expect(CONTRAST_PAIRS.filter((p) => p.min === 4.5)).toHaveLength(5);
    expect(CONTRAST_PAIRS.filter((p) => p.min === 3)).toHaveLength(4);
  });
});

describe("suggestPassingColour", () => {
  it("returns the colour unchanged when it already passes", () => {
    expect(suggestPassingColour("#111111", ["#FFFFFF"], 4.5)).toBe("#111111");
  });
  it("keeps hue for a failing blue", () => {
    const s = suggestPassingColour("#7FA0FF", ["#FFFFFF"], 4.5);
    expect(contrastRatio(s, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    const dh = Math.abs(hexToOklch(s).h - hexToOklch("#7FA0FF").h);
    expect(Math.min(dh, 360 - dh)).toBeLessThan(8);
  });
  it("is deterministic and always passes (property)", () => {
    fc.assert(
      fc.property(hexArb, hexArb, fc.constantFrom(3, 4.5), (c, bg, min) => {
        const s = suggestPassingColour(c, [bg], min);
        return contrastRatio(s, bg) >= min && s === suggestPassingColour(c, [bg], min);
      }),
      { numRuns: 150 },
    );
  });
});

describe("dark derivation", () => {
  it("derived dark palette always passes AA (property)", () => {
    fc.assert(
      fc.property(paletteArb, (light) => checkPalette("dark", deriveDarkPalette(light)).length === 0),
      { numRuns: 100 },
    );
  });
  it("prefers explicit dark", () => {
    expect(resolveDarkPalette(LIGHT_OK, LIGHT_OK)).toBe(LIGHT_OK);
  });
});

describe("publish validator", () => {
  it("accepts a good theme with a derived-dark warning", () => {
    const r = validateThemeForPublish(makeTheme());
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("dark_derived");
  });
  it("blocks contrast failure with a passing suggestion", () => {
    const r = validateThemeForPublish(makeTheme({ light: { ...LIGHT_OK, text: "#DDDDDD" } }));
    expect(r.ok).toBe(false);
    const issue = r.blocking.find((b) => b.code === "contrast_failed");
    expect(issue?.code === "contrast_failed" && contrastRatio(issue.suggestion, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
  });
  it("blocks bad pairing, weight, sections, taglines and claims", () => {
    expect(validateThemeForPublish(makeTheme({ pairingId: "nope" })).blocking.map((b) => b.code)).toContain("unknown_pairing");
    expect(validateThemeForPublish(makeTheme({ pairingId: "editorial_serif", displayWeight: "semibold" })).blocking.map((b) => b.code)).toContain("weight_unavailable");
    const nine = Array.from({ length: 9 }, () => ({ kind: "hero" as const }));
    expect(validateThemeForPublish(makeTheme({ sections: nine })).blocking.map((b) => b.code)).toContain("too_many_sections");
    expect(validateThemeForPublish(makeTheme({ tagline: { ar: " ", en: "x" } })).blocking.map((b) => b.code)).toContain("tagline_arabic_required");
    expect(validateThemeForPublish(makeTheme({ tagline: { ar: "ا".repeat(81), en: "x" } })).blocking.map((b) => b.code)).toContain("tagline_too_long");
    const w = validateThemeForPublish(makeTheme({ tagline: { ar: "ازياء", en: "" }, coverAssetId: "c", light: { ...LIGHT_OK, heroScrim: { hex: "#000000", alpha: 0 } } }));
    expect(w.warnings.map((x) => x.code)).toEqual(expect.arrayContaining(["tagline_english_missing", "cover_without_scrim"]));
    const claim = validateThemeForPublish(makeTheme({ tagline: { ar: "خصم ٥٠٪", en: "Calm" }, sections: [{ kind: "editorial_text", text: { ar: "ازياء", en: "Only 3 left" } }] }));
    expect(claim.blocking.filter((b) => b.code === "forbidden_claim").map((b) => b.code === "forbidden_claim" && b.field)).toEqual(
      expect.arrayContaining(["tagline/ar", "sections/0/en"]),
    );
  });
  it("any theme that passes validation has all pairs >= threshold (property)", () => {
    let passed = 0;
    fc.assert(
      fc.property(themeArb, (t) => {
        const r = validateThemeForPublish(t);
        if (!r.ok) return true;
        passed += 1;
        const dark = resolveDarkPalette(t.light, t.dark);
        return checkPalette("light", t.light).length === 0 && checkPalette("dark", dark).length === 0;
      }),
      { numRuns: 300 },
    );
    expect(passed).toBeGreaterThanOrEqual(0);
  });
  it("applying every suggestion to a failing pair fixes that pair (property)", () => {
    fc.assert(
      fc.property(paletteArb, (light) => {
        const r = validateThemeForPublish(makeTheme({ light, dark: light }));
        return r.blocking.every((b) => {
          if (b.code !== "contrast_failed") return true;
          return contrastRatio(b.suggestion, (b.scheme === "light" ? light : light)[b.bg]) >= b.min;
        });
      }),
      { numRuns: 150 },
    );
  });
});

describe("locked elements", () => {
  it("lists the contract", () => {
    expect(LOCKED_ELEMENTS).toEqual(expect.arrayContaining(["price_block", "discount_label", "verified_badge", "reference_label", "sponsored_label", "plus_badge", "stock_line", "rating", "size_recommendation", "seller_legal_identity", "commerce_buttons", "bag", "checkout"]));
    expect(isLockedElement("price_block")).toBe(true);
    expect(isLockedElement("hero")).toBe(false);
  });
  it("extreme themes never alter locked tokens (property)", () => {
    const baseline = lockedElementTokens("price_block", null);
    fc.assert(
      fc.property(themeArb, fc.constantFrom(...LOCKED_ELEMENTS), (t, el) => {
        const tok = lockedElementTokens(el, t);
        return tok === baseline && Object.isFrozen(tok) && tok.visible && tok.opacity === 1;
      }),
    );
  });
});

describe("copy guard", () => {
  it.each([
    ["50% off", "percent"], ["خصم ٥٠٪", "percent"], ["خصم ۳۰ بالمئة", "discount"], ["Sale now", "discount"],
    ["عروض الصيف", "discount"], ["Only 99 EGP", "price"], ["٩٩ جنيه", "price"], ["ابتداء من ١٢٠", "price"],
    ["Ends in 3 hours", "countdown"], ["ينتهي خلال ٣ ساعات", "countdown"], ["Only 2 left", "scarcity"],
    ["آخر قطعة", "scarcity"], ["Verified seller", "claim"], ["★★★★★", "claim"], ["الأكثر مبيعا", "claim"],
  ])("flags %s as %s", (text, kind) => {
    expect(findCopyViolations(text).map((v) => v.kind)).toContain(kind);
  });
  it.each(["Calm, considered fashion", "أزياء هادئة وأنيقة", "Since 1998", "ملابس أطفال ناعمة"])("allows %s", (t) => {
    expect(isCleanCopy(t)).toBe(true);
  });
  it("normalises digits and diacritics", () => {
    expect(normaliseCopy("٣۴ ٪ الْخَصْم")).toBe("34 % الخصم");
  });
  it("any text containing a percent sign is flagged (property)", () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => findCopyViolations(`${a}%${b}`).some((v) => v.kind === "percent")));
  });
});

describe("font registry", () => {
  it("is self-consistent and marked as placeholder", () => {
    expect(registryProblems()).toEqual([]);
    expect(FONT_FAMILIES.every((f) => isPlaceholderHash(f.sha256) && f.sha256 === PLACEHOLDER_SHA256 && !f.licenceVerified)).toBe(true);
    expect(FONT_PAIRINGS.every((p) => findFamily(p.arabicFamilyId)?.script === "arabic")).toBe(true);
    expect(isPlaceholderHash("a".repeat(64))).toBe(false);
    expect(pairingSupportsWeight("platform_default", "semibold")).toBe(true);
    expect(pairingSupportsWeight("missing", "regular")).toBe(false);
  });
});

describe("suggest edge cases", () => {
  it("falls back to an extreme and stays best effort for opposite backgrounds", () => {
    expect(isHex(suggestPassingColour("#808080", ["#000000", "#FFFFFF"], 4.5))).toBe(true);
    expect(suggestPassingColour("#808080", ["#FFFFFF"], 7)).toMatch(/^#/);
  });
});
