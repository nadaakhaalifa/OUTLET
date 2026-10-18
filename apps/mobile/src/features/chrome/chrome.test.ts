import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_SEGMENTS, otherLocale, themeSegmentIcon, LOCALE_NATIVE_NAME } from "./model";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("chrome toggle logic", () => {
  it("shows the other language in its own script", () => {
    expect(LOCALE_NATIVE_NAME[otherLocale("en")]).toBe("العربية");
    expect(LOCALE_NATIVE_NAME[otherLocale("ar")]).toBe("English");
    expect(LOCALE_NATIVE_NAME[otherLocale("en-GB")]).toBe("العربية");
  });
  it("has a distinct icon per segment", () => {
    expect(new Set(THEME_SEGMENTS.map(themeSegmentIcon)).size).toBe(2);
  });
});

describe("theme segments", () => {
  it("shows sun and moon only, tap-to-select", () => {
    expect(THEME_SEGMENTS).toEqual(["light", "dark"]);
    const c = src("./ThemeSegments.tsx");
    expect(c).toContain("setPreference(p)");
    expect(c).not.toContain("theme.system");
    expect(c).not.toContain("themeShort");
    expect(c).toContain("selected: active");
    expect(c).toContain("theme-${p}");
  });
});

describe("account screen source guard", () => {
  const s = src("../account-creation/AccountCreateScreen.tsx");
  it("drops the two legal links and the bottom language button", () => {
    expect(s).not.toContain("onboarding.account.termsOpen");
    expect(s).not.toContain("onboarding.account.privacyOpen");
    expect(s).not.toContain("onboarding.account.language");
    expect(s).not.toContain("toggleLanguage");
  });
  it("has one combined legal link and the shared toggle", () => {
    expect(s).toContain("terms-privacy-link");
    expect(s).toContain("/legal/combined");
    expect(s).toContain("LanguageThemeToggle");
  });
  it("keeps the unticked consent checkbox", () => {
    expect(s).toContain("useState(false)");
    expect(s).toContain("terms-accept");
  });
});
