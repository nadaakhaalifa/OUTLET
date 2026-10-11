import { describe, expect, it } from "vitest";
import { countdown, formatMoney, parseMinor } from "./format";

describe("format", () => {
  it("formats integer piastres without floats", () => {
    expect(formatMoney(123456n, "en")).toBe("EGP 1,234.56");
    expect(formatMoney(-5n, "en")).toBe("EGP ‎-0.05");
    expect(formatMoney(100n, "en")).toBe("EGP 1");
    expect(formatMoney(9007199254740993n, "en")).toContain("90,071,992,547,409.93");
  });
  it("parses only integer strings", () => {
    expect(parseMinor("-12")).toBe(-12n);
    expect(parseMinor("1.5")).toBeNull();
    expect(parseMinor("")).toBeNull();
  });
  it("countdown uses the supplied clock", () => {
    expect(countdown(1000 + 90_000_000, 1000)).toEqual({ overdue: false, unit: "days", amount: 1 });
    expect(countdown(0, 7_200_000)).toEqual({ overdue: true, unit: "hours", amount: 2 });
    expect(countdown(60_000, 0)).toEqual({ overdue: false, unit: "minutes", amount: 1 });
  });
});
