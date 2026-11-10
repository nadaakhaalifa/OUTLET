import { money } from "@outlet/money";
import { describe, expect, it } from "vitest";
import { checkCatalogs } from "../scripts/check-catalogs.mjs";
import {
  CATALOGS, DEFAULT_LOCALE, LOCALES, createTranslator, dir, formatDate, formatMoney, formatRelative, hreflang, isLocale,
  localeSegment, minorToDecimalString, resolveLocale, t,
} from "../src/index.js";

describe("catalogs", () => {
  it("ar-EG and en-EG agree (the CI check)", () => {
    expect(checkCatalogs(CATALOGS["ar-EG"], CATALOGS["en-EG"])).toEqual([]);
  });
  it("check-catalogs reports every class of problem", () => {
    const problems = checkCatalogs(
      { h: "x", a: "x", b: "", c: "خصم ٦٠٪", d: "{n, plural, one {#} other {# x}}", e: "{oops", f: "hi {name}" },
      { a: "x", b: "y", c: "10 off", g: "z", d: "{n, plural, one {#} other {# x}}", e: "ok", f: "hi {who}" },
    );
    const text = problems.join("\n");
    expect(text).toContain("missing in ar-EG: g");
    expect(text).toContain("missing in en-EG: h");
    expect(text).toContain("ar-EG.b: empty value");
    expect(text).toContain("ar-EG.c: hard-coded digit");
    expect(text).toContain("en-EG.c: hard-coded digit");
    expect(text).toContain("ar-EG.e: invalid ICU message");
    expect(text).toContain("f: placeholders differ");
    expect(text).not.toContain("ar-EG.d");
  });
});

describe("t", () => {
  it("translates and interpolates in both locales", () => {
    expect(t("ar-EG", "nav.explore")).toBe("استكشف المتاجر");
    expect(t("en-EG", "nav.explore")).toBe("Explore stores");
    expect(t("en-EG", "price.percentOff", { percent: 60 })).toBe("60% off");
    expect(t("ar-EG", "price.percentOff", { percent: 60 })).toBe("خصم ٦٠٪");
    expect(t("ar-EG", "price.percentOff", { percent: 60 }, { numerals: "latn" })).toBe("خصم 60٪");
  });
  it("handles Arabic plural categories", () => {
    const tr = createTranslator("ar-EG");
    expect(tr("price.lowest30d", { days: 30 })).toContain("٣٠ يومًا");
    expect(tr("price.lowest30d", { days: 2 })).toContain("يومين");
    expect(tr("price.lowest30d", { days: 5 })).toContain("٥ أيام");
    expect(createTranslator("en-EG")("price.lowest30d", { days: 1 })).toBe("Lowest price in 1 day");
  });
  it("rejects unknown keys at compile time", () => {
    // @ts-expect-error not a catalog key
    expect(() => t("ar-EG", "no.such.key")).toThrow();
  });
});

describe("formatMoney", () => {
  it("matches the spec examples", () => {
    expect(formatMoney(money(120_000n, "EGP"), "ar-EG")).toBe("١٬٢٠٠ ج.م");
    expect(formatMoney(money(120_000n, "EGP"), "en-EG")).toBe("EGP 1,200");
    expect(formatMoney(money(120_000n, "EGP"), "ar-EG", { numerals: "latn" })).toBe("1,200 ج.م");
    expect(formatMoney(money(120_000n, "EGP"), "en-EG", { numerals: "arab" })).toBe("EGP ١٬٢٠٠");
  });
  it("keeps piastres when present and handles negatives and zero", () => {
    expect(formatMoney(money(129_950n, "EGP"), "en-EG")).toBe("EGP 1,299.50");
    expect(formatMoney(money(5n, "EGP"), "en-EG")).toBe("EGP 0.05");
    expect(formatMoney(money(0n, "EGP"), "en-EG")).toBe("EGP 0");
    expect(formatMoney(money(-250n, "EGP"), "en-EG")).toContain("2.50");
  });
  it("is exact above 2^53 and for 10^15 minor", () => {
    expect(formatMoney(money(10n ** 15n, "EGP"), "en-EG")).toBe("EGP 10,000,000,000,000");
    expect(formatMoney(money(9_007_199_254_740_993n, "EGP"), "en-EG")).toBe("EGP 90,071,992,547,409.93");
    expect(formatMoney(money(2n ** 62n + 1n, "EGP"), "en-EG", { numerals: "latn" })).toBe("EGP 46,116,860,184,273,879.05");
  });
  it("covers the other currencies", () => {
    expect(formatMoney(money(1_000n, "USD"), "en-EG")).toBe("USD 10");
    expect(formatMoney(money(1_000n, "SAR"), "ar-EG", { numerals: "latn" })).toBe("10 ر.س");
  });
  it("minorToDecimalString is exact", () => {
    expect(minorToDecimalString(123n, 2)).toBe("1.23");
    expect(minorToDecimalString(-5n, 2)).toBe("-0.05");
    expect(minorToDecimalString(7n, 0)).toBe("7");
    expect(minorToDecimalString(1234n, 3)).toBe("1.234");
  });
});

describe("dates", () => {
  const d = new Date("2026-11-08T22:30:00Z"); // 00:30 on 9 Nov in Cairo (UTC+2)
  it("uses Africa/Cairo", () => {
    expect(formatDate(d, "en-EG", { style: "short", numerals: "latn" })).toContain("9");
    expect(formatDate(d, "en-EG", { style: "long", timeZone: "UTC" })).toContain("8");
  });
  it("supports the Hijri calendar", () => {
    const hijri = formatDate(d, "en-EG", { hijri: true, style: "long" });
    expect(hijri).toMatch(/AH|Jumada|Rabi|Rajab|Sha/);
    expect(formatDate(d, "ar-EG")).not.toBe(formatDate(d, "ar-EG", { hijri: true }));
  });
  it("formats relative time", () => {
    const now = new Date("2026-11-08T12:00:00Z");
    expect(formatRelative(new Date("2026-11-08T09:00:00Z"), now, "en-EG")).toBe("3 hours ago");
    expect(formatRelative(new Date("2026-11-10T12:00:00Z"), now, "en-EG")).toBe("in 2 days");
    expect(formatRelative(new Date("2026-11-08T11:59:30Z"), now, "en-EG")).toBe("30 seconds ago");
    expect(formatRelative(new Date("2026-11-08T09:00:00Z"), now, "ar-EG")).toMatch(/٣/);
    expect(formatRelative(now, now, "en-EG")).toBe("now");
  });
});

describe("locale negotiation", () => {
  it("resolves [market]-[locale] segments", () => {
    expect(resolveLocale("eg-ar")).toEqual({ marketId: "eg", locale: "ar-EG", dir: "rtl" });
    expect(resolveLocale("eg-en")).toEqual({ marketId: "eg", locale: "en-EG", dir: "ltr" });
  });
  it("rejects unknown markets, languages and malformed segments", () => {
    for (const s of ["sa-ar", "eg-fr", "EG-ar", "eg", "eg-ar-x", "", "eg_ar"]) expect(resolveLocale(s)).toBeNull();
  });
  it("round-trips and exposes helpers", () => {
    expect(localeSegment("eg", "ar-EG")).toBe("eg-ar");
    expect(resolveLocale(localeSegment("eg", "en-EG"))?.locale).toBe("en-EG");
    expect(dir("ar-EG")).toBe("rtl");
    expect(dir("en-EG")).toBe("ltr");
    expect(DEFAULT_LOCALE).toBe("ar-EG");
    expect(LOCALES).toHaveLength(2);
    expect(isLocale("ar-EG")).toBe(true);
    expect(isLocale("fr-FR")).toBe(false);
    expect(hreflang("en-EG")).toBe("en-EG");
  });
});
