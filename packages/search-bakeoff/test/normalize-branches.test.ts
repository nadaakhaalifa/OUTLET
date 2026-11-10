import { describe, expect, it } from "vitest";
import { normalizeArabic, toAsciiDigits, tokenize } from "../src/normalize.js";

describe("normalize branches", () => {
  it("maps Eastern Arabic and Persian digits to ASCII", () => {
    expect(toAsciiDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(toAsciiDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });
  it("folds alef, ya, ta-marbuta, tatweel, separators", () => {
    expect(normalizeArabic("أإآ ى ة")).toBe("ااا ي ه");
    expect(normalizeArabic("كــتاب")).toBe("كتاب");
    expect(normalizeArabic("١٫٥ ٬ ،")).toBe("1.5 , ,");
  });
  it("is idempotent and stable on empty input", () => {
    const once = normalizeArabic("  Ｈello   ٣ ");
    expect(normalizeArabic(once)).toBe(once);
    expect(normalizeArabic("")).toBe("");
  });
  it("keeps thousands groups as one token and trims dots", () => {
    expect(tokenize("under ١,٥٠٠ EGP...")).toEqual(["under", "1500", "egp"]);
    expect(tokenize("a, b")).toEqual(["a", "b"]);
    expect(tokenize("   ")).toEqual([]);
  });
});
