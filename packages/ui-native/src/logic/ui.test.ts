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
  it("disabled dims", () => {
    const s = buttonStyle({ variant: "destructive", loading: false, disabled: true, pressed: true }, c);
    expect(s.opacity).toBe(0.4);
    expect(s.background).toBe(c.danger);
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
    expect(fieldView({ focused: true, disabled: false }, c).borderColor).toBe(c.accent);
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
