import { describe, expect, it } from "vitest";
import { formatBps, formatMoney } from "./format";

describe("formatMoney", () => {
  it("formats whole pounds without decimals", () => {
    expect(formatMoney(150_000n, "en")).toBe("EGP 1,500");
  });
  it("keeps piastres exact", () => {
    expect(formatMoney(150_005n, "en")).toBe("EGP 1,500.05");
    expect(formatMoney(99n, "en")).toBe("EGP 0.99");
  });
  it("handles negatives and bigint beyond 2^53", () => {
    expect(formatMoney(-250n, "en")).toBe("EGP ‎-2.50");
    expect(formatMoney(900_719_925_474_099_300n, "en")).toContain("9,007,199,254,740,993");
  });
  it("uses Eastern Arabic digits and the Arabic unit in ar", () => {
    const s = formatMoney(120_000n, "ar");
    expect(s).toContain("ج.م");
    expect(s).toMatch(/[٠-٩]/);
  });
});
describe("formatBps", () => {
  it("formats with one decimal at most", () => {
    expect(formatBps(1250, "en")).toBe("12.5%");
    expect(formatBps(5000, "en")).toBe("50%");
  });
});
