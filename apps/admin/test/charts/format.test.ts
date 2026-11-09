import { describe, expect, it } from "vitest";
import { deltaOf, deltaText, formatWith } from "../../src/lib/charts/format";

describe("format", () => {
  it("formats EGP from piastres, never JOD", () => {
    const en = formatWith({ kind: "money", locale: "en-EG" }, 123456);
    expect(en).toContain("1,234.56");
    expect(en).toContain("EGP");
    expect(formatWith({ kind: "money", locale: "ar-EG" }, 150000)).toContain("ج.م");
    expect(formatWith({ kind: "moneyCompact", locale: "en-EG" }, 250_000_00)).toBe("250K EGP");
  });
  it("uses Arabic digits in ar-EG", () => {
    expect(formatWith({ kind: "number", locale: "ar-EG" }, 12)).toBe("١٢");
  });
  it("delta has no percentage against zero or missing", () => {
    expect(deltaOf(5, 0)).toEqual({ ratio: null, tone: "none" });
    expect(deltaOf(null, 3).tone).toBe("none");
    expect(deltaOf(110, 100).tone).toBe("up");
    expect(deltaOf(90, 100).tone).toBe("down");
    expect(deltaOf(100.01, 100).tone).toBe("flat");
    expect(deltaText(deltaOf(110, 100), "en-EG")).toBe("+10%");
    expect(deltaText(deltaOf(1, 0), "en-EG")).toBeNull();
  });
});
