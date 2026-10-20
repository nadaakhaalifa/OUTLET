import { describe, expect, it } from "vitest";
import { formatAmount, localizeDigits } from "./money-display";

describe("Arabic money and percent separators", () => {
  it("uses Arabic decimal and thousands separators for piastre amounts", () => {
    expect(formatAmount(2_116_884n, "ar")).toBe("٢١٬١٦٨٫٨٤");
    expect(formatAmount(123_400n, "ar")).toBe("١٬٢٣٤");
    expect(formatAmount(-125_050n, "ar")).toBe("-١٬٢٥٠٫٥٠");
  });

  it("keeps ASCII separators in English", () => {
    expect(formatAmount(2_116_884n, "en")).toBe("21,168.84");
  });

  it("localises percent digits with the Arabic decimal separator", () => {
    expect(localizeDigits((14 / 10).toFixed(1), "ar")).toBe("١٫٤");
  });

  it("matches Intl.NumberFormat('ar-EG') for the same values", () => {
    const intl = new Intl.NumberFormat("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(formatAmount(2_116_884n, "ar")).toBe(intl.format(21_168.84));
    const intlInt = new Intl.NumberFormat("ar-EG");
    expect(formatAmount(123_400n, "ar")).toBe(intlInt.format(1_234));
  });
});
